/**
 * BOX-LOGIN BRIDGE — proxy refresh: the sandbox proxy re-reads the HOST's
 * login file beside every active-only `renewBoxLifetime()` site (prompt
 * dispatch + streamed events), behind {@link BOX_LOGIN_REFRESH_THROTTLE_MS},
 * and never after `close()`/`detach()`. The DIGEST gate itself (an unchanged
 * copy is never rewritten) lives in `createBoxLoginRefresher` and is exercised
 * end-to-end here with the real refresher wired as `refreshLoginFile`.
 *
 * Harness mirrors `sandbox-proxy-renew.test.ts` — fake host, fake timers over
 * `Date` only, an SSE stub turn.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import {
  BOX_LOGIN_REFRESH_THROTTLE_MS,
  createSandboxAgentSessionProxy,
} from "../sandbox-agent-session-proxy.js"
import {
  buildLoginCopy,
  createBoxLoginRefresher,
  type BoxLoginDecl,
} from "../box-login-bridge.js"
import type { AgentStreamEvent } from "../sessions.js"

type FakeHost = Parameters<typeof createSandboxAgentSessionProxy>[0]["host"]

function makeHost(overrides: Partial<FakeHost> = {}): FakeHost {
  return {
    prompt: vi.fn(async () => {}),
    interrupt: vi.fn(async () => ({ wasBusy: false })),
    output: vi.fn(async () => ""),
    kill: vi.fn(async () => {}),
    waitForAny: vi.fn(async () => ({ timedOut: false, event: "turn-end" as const, sessionIds: [] })),
    currentEventsCursor: vi.fn(async () => 0),
    stop: vi.fn(async () => {}),
    mcpUrl: "http://127.0.0.1:18792/mcp",
    ...overrides,
  }
}

async function collect(iter: AsyncIterable<AgentStreamEvent>): Promise<AgentStreamEvent[]> {
  const events: AgentStreamEvent[] = []
  for await (const ev of iter) events.push(ev)
  return events
}

function sseResponse(records: Array<Record<string, unknown>>): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder()
      controller.enqueue(encoder.encode(": connected\n\n"))
      for (const rec of records) controller.enqueue(encoder.encode(`data: ${JSON.stringify(rec)}\n\n`))
      controller.close()
    },
  })
  return new Response(body, { status: 200 })
}

const TURN = [
  { seq: 1, ts: "t", kind: "text-delta", sessionId: "remote_1", text: "a\n" },
  { seq: 2, ts: "t", kind: "turn-end", sessionId: "remote_1", reason: "completed" },
]

describe("sandbox proxy — box login file refresh", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => sseResponse(TURN)),
    )
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it("refreshes beside the lifetime renewal on prompt dispatch", async () => {
    const refreshLoginFile = vi.fn(async () => "unchanged" as const)
    const proxy = createSandboxAgentSessionProxy({
      host: makeHost(),
      remoteSessionId: "remote_1",
      refreshLoginFile,
    })

    await collect(proxy.send("go"))

    expect(refreshLoginFile).toHaveBeenCalledTimes(1)
  })

  it("throttles the refresh to once per window, again once it elapses", async () => {
    const refreshLoginFile = vi.fn(async () => "unchanged" as const)
    const proxy = createSandboxAgentSessionProxy({
      host: makeHost(),
      remoteSessionId: "remote_1",
      refreshLoginFile,
    })

    await collect(proxy.send("one"))
    expect(refreshLoginFile).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(BOX_LOGIN_REFRESH_THROTTLE_MS - 1_000)
    await collect(proxy.send("two"))
    expect(refreshLoginFile).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(2_000)
    await collect(proxy.send("three"))
    expect(refreshLoginFile).toHaveBeenCalledTimes(2)
  })

  it("never refreshes after the proxy is closed", async () => {
    const refreshLoginFile = vi.fn(async () => "unchanged" as const)
    const proxy = createSandboxAgentSessionProxy({
      host: makeHost(),
      remoteSessionId: "remote_1",
      refreshLoginFile,
    })
    await collect(proxy.send("go"))
    expect(refreshLoginFile).toHaveBeenCalledTimes(1)

    await proxy.close()
    vi.advanceTimersByTime(3 * BOX_LOGIN_REFRESH_THROTTLE_MS)
    await collect(proxy.send("again"))

    expect(refreshLoginFile).toHaveBeenCalledTimes(1)
  })

  it("never refreshes after the proxy is detached — a detached box is nobody's to touch", async () => {
    const refreshLoginFile = vi.fn(async () => "unchanged" as const)
    const proxy = createSandboxAgentSessionProxy({
      host: makeHost(),
      remoteSessionId: "remote_1",
      detachable: true,
      refreshLoginFile,
    })
    await collect(proxy.send("go"))
    expect(refreshLoginFile).toHaveBeenCalledTimes(1)

    proxy.detach?.()
    vi.advanceTimersByTime(3 * BOX_LOGIN_REFRESH_THROTTLE_MS)
    // A turn dispatched after a detach PARKS forever by design — start it,
    // let the refresh gate run, never await it.
    void collect(proxy.send("again")).catch(() => undefined)
    await new Promise(resolve => setImmediate(resolve))

    expect(refreshLoginFile).toHaveBeenCalledTimes(1)
  })

  it("a rejecting refresh is logged and never breaks the turn", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const refreshLoginFile = vi.fn(async (): Promise<never> => {
      throw new Error("login file vanished")
    })
    const proxy = createSandboxAgentSessionProxy({
      host: makeHost(),
      remoteSessionId: "remote_1",
      refreshLoginFile,
    })

    const events = await collect(proxy.send("go"))
    await Promise.resolve()

    expect(events.at(-1)).toEqual({ kind: "turn-end", reason: "completed" })
    expect(refreshLoginFile).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it("the digest gate skips an identical copy and rewrites only a changed one", async () => {
    const decl: BoxLoginDecl = {
      recipe: "codex",
      file: ".codex/auth.json",
      keep: ["tokens.access_token", "tokens.account_id", "last_refresh"],
    }
    const hostLogin = {
      body: JSON.stringify({
        tokens: { access_token: "tok-a", refresh_token: "secret-a", account_id: "acct_1" },
        last_refresh: "2026-10-14T00:00:00.000Z",
      }),
    }
    const bootCopy = buildLoginCopy(decl, hostLogin.body)
    expect(bootCopy.ok).toBe(true)
    if (!bootCopy.ok) return

    const writes: Array<{ path: string; body: string }> = []
    const write = vi.fn(async (path: string, data: Uint8Array) => {
      writes.push({ path, body: new TextDecoder().decode(data) })
    })
    const path = "/home/user/.codex/auth.json"
    const proxy = createSandboxAgentSessionProxy({
      host: makeHost(),
      remoteSessionId: "remote_1",
      refreshLoginFile: createBoxLoginRefresher({
        decl,
        path,
        read: async () => hostLogin.body,
        write,
        // The digest the boot-time upload left in the box.
        digest: bootCopy.digest,
      }),
    })

    // Identical host login — never rewritten.
    await collect(proxy.send("one"))
    expect(write).not.toHaveBeenCalled()

    // The host re-logged in while this box keeps working — rewritten once.
    vi.advanceTimersByTime(BOX_LOGIN_REFRESH_THROTTLE_MS + 1_000)
    hostLogin.body = JSON.stringify({
      tokens: { access_token: "tok-b", refresh_token: "secret-b", account_id: "acct_1" },
      last_refresh: "2026-10-14T01:00:00.000Z",
    })
    await collect(proxy.send("two"))
    expect(write).toHaveBeenCalledTimes(1)
    expect(writes[0]!.path).toBe(path)
    expect(writes[0]!.body).toContain("tok-b")
    expect(writes[0]!.body).not.toContain("secret-b")

    // Changed again after the new digest became the gate — rewritten again.
    vi.advanceTimersByTime(BOX_LOGIN_REFRESH_THROTTLE_MS + 1_000)
    hostLogin.body = JSON.stringify({
      tokens: { access_token: "tok-c", refresh_token: "secret-c", account_id: "acct_1" },
      last_refresh: "2026-10-14T02:00:00.000Z",
    })
    await collect(proxy.send("three"))
    expect(write).toHaveBeenCalledTimes(2)
    expect(writes[1]!.body).toContain("tok-c")
  })
})
