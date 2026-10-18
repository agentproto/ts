/**
 * Integration — a sandboxed session survives a daemon restart END TO END on
 * the fake provider: daemon A detaches at stop (box + agent keep running,
 * sessions.json keeps the row), the next boot on the SAME agentproto dir
 * reconnects to the SAME sandboxId (never boots a fresh box), binds the
 * SAME session id, and the session is immediately live again.
 *
 * Hermetic: the box daemon is a fake host + stubbed `fetch`, provider
 * resolution is stubbed at `createSandboxAgentSessionHost` so the pass can
 * prove the sandboxId was REUSED (connect, not boot).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const providerMock = vi.hoisted(() => ({
  createSandboxAgentSessionHost: vi.fn(),
}))

vi.mock("@agentproto/sandbox", async importOriginal => {
  const actual = await importOriginal<typeof import("@agentproto/sandbox")>()
  return {
    ...actual,
    createSandboxAgentSessionHost: providerMock.createSandboxAgentSessionHost,
  }
})

import { createSandboxAgentSessionProxy } from "../sandbox-agent-session-proxy.js"
import { readSandboxLedger, recordSandboxBoot } from "../sandbox-ledger.js"
import { runSandboxReattachPass } from "../sandbox-reattach.js"
import { createSessionsRegistry, type AgentStreamEvent } from "../sessions.js"
import { createSessionEventBus } from "../session-event-bus.js"

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
    close: vi.fn(async () => {}),
    extendTimeout: vi.fn(async () => {}),
    mcpUrl: "http://127.0.0.1:18791/mcp",
    ...overrides,
  }
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

/** SSE body stubbing the box daemon's `/sessions/:id/events/stream`. */
function streamResponse(records: Array<Record<string, unknown>>): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder()
      controller.enqueue(enc.encode(": connected\n\n"))
      for (const rec of records) controller.enqueue(enc.encode(`data: ${JSON.stringify(rec)}\n\n`))
      controller.close()
    },
  })
  return new Response(body, { status: 200 })
}

async function collect(iter: AsyncIterable<AgentStreamEvent>): Promise<AgentStreamEvent[]> {
  const events: AgentStreamEvent[] = []
  for await (const ev of iter) events.push(ev)
  return events
}

describe("integration — sandbox session survives a daemon restart (fake provider)", () => {
  let tmp: string
  const prevLedger = process.env.AGENTPROTO_SANDBOX_LEDGER

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "sandbox-restart-it-"))
    process.env.AGENTPROTO_SANDBOX_LEDGER = join(tmp, "sandboxes.json")
    providerMock.createSandboxAgentSessionHost.mockReset()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    if (prevLedger === undefined) delete process.env.AGENTPROTO_SANDBOX_LEDGER
    else process.env.AGENTPROTO_SANDBOX_LEDGER = prevLedger
    rmSync(tmp, { recursive: true, force: true })
  })

  const persistedRow = (id: string): Record<string, unknown> => {
    const snap = JSON.parse(readFileSync(join(tmp, "sessions.json"), "utf8")) as {
      sessions: Array<Record<string, unknown>>
    }
    const row = snap.sessions.find(r => r.id === id)
    if (!row) throw new Error(`no persisted row ${id}`)
    return row
  }

  const newRegistry = () =>
    createSessionsRegistry({
      persistPath: join(tmp, "sessions.json"),
      transcriptDir: join(tmp, "transcripts"),
      sessionEvents: createSessionEventBus(),
    })

  it("detach → fresh boot on the same agentproto dir → SAME sandboxId + session id reattached, live", async () => {
    const host = makeHost()
    const proxy = createSandboxAgentSessionProxy({
      host,
      remoteSessionId: "remote_it",
      detachable: true,
      ledger: { sandboxId: "sbx_it", provider: "e2b" },
    })
    recordSandboxBoot({ sandboxId: "sbx_it", provider: "e2b", state: "connected" })

    // ── runtime A: spawn a sandboxed session backed by the fake box ──
    const registryA = newRegistry()
    const spawned = registryA.spawnAgent({
      workspaceSlug: "default",
      cwd: tmp,
      agentSession: proxy,
      adapterSlug: "claude-code",
      remote: true,
      sandboxId: "sbx_it",
      sandboxProvider: "e2b",
      sandboxTeardown: "pause",
    })
    const sessionId = spawned.id
    recordSandboxBoot({ sandboxId: "sbx_it", provider: "e2b", state: "connected", sessionId })

    // The session is LIVE: a turn runs against the box and settles.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        const url = new URL(input)
        if (url.pathname.endsWith("/events/stream")) {
          return streamResponse([
            { seq: 3, ts: "t", kind: "text-delta", sessionId: "remote_it", text: "did the work\n" },
            { seq: 4, ts: "t", kind: "turn-end", sessionId: "remote_it", reason: "completed" },
          ])
        }
        return json({ busy: false, status: "running" })
      }),
    )
    await registryA.sendPrompt(sessionId, "do the work")
    expect(host.prompt).toHaveBeenCalledWith("remote_it", expect.stringContaining("do the work"))
    expect(registryA.get(sessionId)).toMatchObject({ status: "running", sandboxId: "sbx_it" })

    // ── shutdown: DETACH — connection closes, the box keeps running ──
    await registryA.detachSandboxSessions()
    expect(host.stop).not.toHaveBeenCalled()
    expect(host.kill).not.toHaveBeenCalled()
    const detachedRow = registryA.get(sessionId)
    expect(detachedRow).toMatchObject({ hostDetached: true, status: "running" })
    expect(detachedRow?.sandboxReattach).toMatchObject({ remoteSessionId: "remote_it" })
    registryA.shutdown()
    // shutdown() empties the in-memory map but the persisted snapshot —
    // which the fresh boot loads — keeps the row attachable.
    await registryA.settlePendingWrites()
    expect(persistedRow(sessionId)).toMatchObject({ status: "running", hostDetached: true })
    const ledgerAfterStop = readSandboxLedger().find(r => r.sandboxId === "sbx_it")
    expect(ledgerAfterStop?.state).toBe("connected")
    expect(ledgerAfterStop?.attachedSessions).toEqual([sessionId])

    // ── runtime B: fresh boot on the SAME agentproto dir ──
    const registryB = newRegistry()
    expect(registryB.sandboxReattachCandidates().map(d => d.id)).toEqual([sessionId])
    providerMock.createSandboxAgentSessionHost.mockResolvedValue(host)
    const summary = await runSandboxReattachPass({
      registry: registryB,
      resolveSandboxProvider: async slug =>
        slug === "e2b" ? ({ provider: { id: "e2b" } } as never) : null,
    })
    expect(summary).toEqual({
      candidates: 1,
      reattached: 1,
      gone: 0,
      ended: 0,
      failed: 0,
      unserved: 0,
    })

    // NEVER booted a fresh box: connect was called with the SAME sandboxId.
    expect(providerMock.createSandboxAgentSessionHost).toHaveBeenCalledTimes(1)
    expect(providerMock.createSandboxAgentSessionHost).toHaveBeenCalledWith(
      expect.objectContaining({ sandboxId: "sbx_it" }),
    )

    // The SAME session id is bound again, live, with the box untouched.
    const row = registryB.get(sessionId)
    expect(row).toMatchObject({ id: sessionId, status: "running", sandboxId: "sbx_it" })
    expect(row?.hostDetached).toBeUndefined()
    expect(row?.sandboxReattach).toBeUndefined()
    expect(host.stop).not.toHaveBeenCalled()
    expect(host.kill).not.toHaveBeenCalled()

    // The session is live: a second turn reaches the SAME box session.
    await registryB.sendPrompt(sessionId, "keep going")
    expect(host.prompt).toHaveBeenLastCalledWith("remote_it", expect.stringContaining("keep going"))
    expect(registryB.sandboxSessionStats().attached).toBe(1)

    // A SECOND restart cycle detaches again, symmetrically.
    await registryB.detachSandboxSessions()
    registryB.shutdown()
    expect(host.stop).not.toHaveBeenCalled()
    expect(readSandboxLedger().find(r => r.sandboxId === "sbx_it")?.state).toBe("connected")
  })
})
