/**
 * Sandbox sessions survive a host-daemon restart: shutdown DETACHES (closes the
 * connection, leaves the box and its agent session running) and the next boot
 * REATTACHES to the same session id.
 *
 * Three layers, all hermetic (fake host / fake provider, stubbed `fetch`, tmp
 * persistence + ledger — no live e2b):
 *   1. the proxy's `detach` / `probeReattach` / `resumeTurn`;
 *   2. the registry's `detachSandboxSessions` / `shutdown` persistence and
 *      `finishSandboxReattach` resolution;
 *   3. `runSandboxReattachPass` against a fake provider.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const providerMock = vi.hoisted(() => ({
  create: vi.fn(),
}))

vi.mock("@agentproto/sandbox", async importOriginal => {
  const actual = await importOriginal<typeof import("@agentproto/sandbox")>()
  return { ...actual, createSandboxAgentSessionHost: providerMock.create }
})

import { SandboxBoxGoneError } from "@agentproto/sandbox"
import {
  createSandboxAgentSessionProxy,
  DETACHED_BOX_LIFETIME_MS,
} from "../sandbox-agent-session-proxy.js"
import { readSandboxLedger, upsertSandboxLedger } from "../sandbox-ledger.js"
import type { SandboxProviderResolver } from "../sandbox-adapters.js"
import { runSandboxReattachPass } from "../sandbox-reattach.js"
import {
  createSessionsRegistry,
  isResumable,
  type AgentSessionLike,
  type AgentStreamEvent,
  type SessionDescriptor,
} from "../sessions.js"
import { createSessionEventBus } from "../session-event-bus.js"

type FakeHost = Parameters<typeof createSandboxAgentSessionProxy>[0]["host"]

function makeHost(overrides: Partial<FakeHost> = {}): FakeHost {
  return {
    prompt: vi.fn(async () => {}),
    output: vi.fn(async () => ""),
    kill: vi.fn(async () => {}),
    waitForAny: vi.fn(async () => ({ timedOut: false, event: "turn-end" as const, sessionIds: [] })),
    currentEventsCursor: vi.fn(async () => 0),
    stop: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    extendTimeout: vi.fn(async () => {}),
    mcpUrl: "http://127.0.0.1:18790/mcp",
    ...overrides,
  }
}

function sseResponse(records: Array<Record<string, unknown>>): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder()
      controller.enqueue(encoder.encode(": connected\n\n"))
      for (const rec of records) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(rec)}\n\n`))
      }
      controller.close()
    },
  })
  return new Response(body, { status: 200 })
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

async function collect(iter: AsyncIterable<AgentStreamEvent>): Promise<AgentStreamEvent[]> {
  const events: AgentStreamEvent[] = []
  for await (const ev of iter) events.push(ev)
  return events
}

/** Route stubbed `fetch` by box-daemon path. */
function stubBox(routes: {
  session?: () => Response
  events?: (since: string | null) => Response
  stream?: (since: string | null) => Response
}): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (input: string | URL) => {
    const url = new URL(input)
    const since = url.searchParams.get("since")
    if (url.pathname.endsWith("/events/stream")) {
      return routes.stream ? routes.stream(since) : new Response(null, { status: 404 })
    }
    if (url.pathname.endsWith("/events")) {
      return routes.events ? routes.events(since) : json({ events: [] })
    }
    return routes.session ? routes.session() : json({ busy: false, status: "running" })
  })
  vi.stubGlobal("fetch", fetchMock)
  return fetchMock
}

describe("sandbox proxy — detach", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("detach() closes the connection only: no host.kill, no host.stop, and returns the reattach record", () => {
    const host = makeHost()
    const proxy = createSandboxAgentSessionProxy({
      host,
      remoteSessionId: "remote_1",
      detachable: true,
      initialTranscriptCursor: 7,
    })

    expect(proxy.detachRecord?.()).toEqual({ remoteSessionId: "remote_1", transcriptSeq: 7 })
    const record = proxy.detach?.()

    expect(record).toEqual({ remoteSessionId: "remote_1", transcriptSeq: 7 })
    expect(host.close).toHaveBeenCalledTimes(1)
    expect(host.kill).not.toHaveBeenCalled()
    expect(host.stop).not.toHaveBeenCalled()
    // Idempotent: the process-exit net calls it again.
    expect(proxy.detach?.()).toEqual(record)
    expect(host.close).toHaveBeenCalledTimes(1)
  })

  it("detach() stops the watchdog and checkpoint timers: a deliberately detached box is never probed, snapshotted, or reported dead", async () => {
    vi.useFakeTimers()
    try {
      const probe = vi.fn(async () => "dead" as const)
      const run = vi.fn(async () => {})
      const proxy = createSandboxAgentSessionProxy({
        host: makeHost(),
        remoteSessionId: "remote_1",
        detachable: true,
        checkpoint: { run, intervalMs: 1_000 },
        watchdog: { probe, intervalMs: 1_000, failureThreshold: 1 },
      })
      const onDisconnect = vi.fn()
      proxy.onDisconnect?.(onDisconnect)
      proxy.detach?.()
      await vi.advanceTimersByTimeAsync(10_000)
      expect(probe).not.toHaveBeenCalled()
      expect(run).not.toHaveBeenCalled()
      expect(onDisconnect).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it("close() after detach is a no-op — a late safety-net close never kills the surviving box", async () => {
    const host = makeHost()
    const proxy = createSandboxAgentSessionProxy({ host, remoteSessionId: "r", detachable: true })
    proxy.detach?.()

    await proxy.close({ daemonShutdown: true })

    expect(host.kill).not.toHaveBeenCalled()
    expect(host.stop).not.toHaveBeenCalled()
  })

  it("an explicit close() of a detachable proxy still kills the remote session and stops the box", async () => {
    const host = makeHost()
    const proxy = createSandboxAgentSessionProxy({ host, remoteSessionId: "r", detachable: true })

    await proxy.close()

    expect(host.kill).toHaveBeenCalledWith("r")
    expect(host.stop).toHaveBeenCalledTimes(1)
    // Nothing left to detach once it has been torn down.
    expect(proxy.detach?.()).toBeUndefined()
  })

  it("an in-flight send() parks on detach: it neither throws nor returns", async () => {
    // A stream that never ends and never carries a turn-end.
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode(": connected\n\n"))
      },
    })
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: string | URL, init?: { signal?: AbortSignal }) => {
        init?.signal?.addEventListener("abort", () => {
          // Real fetch rejects the read on abort; emulate by erroring the body.
        })
        return new Response(body, { status: 200 })
      }),
    )
    const host = makeHost()
    const proxy = createSandboxAgentSessionProxy({ host, remoteSessionId: "r", detachable: true })

    let settled = false
    const turn = collect(proxy.send("go")).then(
      () => {
        settled = true
      },
      () => {
        settled = true
      },
    )
    await new Promise(res => setTimeout(res, 20))
    proxy.detach?.()
    await new Promise(res => setTimeout(res, 50))

    expect(settled).toBe(false)
    expect(host.kill).not.toHaveBeenCalled()
    void turn
  })

  it("extendDetachedLifetime asks the provider for the documented detached lifetime and swallows a rejection", async () => {
    const host = makeHost()
    const proxy = createSandboxAgentSessionProxy({ host, remoteSessionId: "r", detachable: true })
    await proxy.extendDetachedLifetime?.()
    expect(host.extendTimeout).toHaveBeenCalledWith(DETACHED_BOX_LIFETIME_MS)
    expect(DETACHED_BOX_LIFETIME_MS).toBe(60 * 60_000)

    const failing = makeHost({
      extendTimeout: vi.fn(async () => {
        throw new Error("plan cap")
      }),
    })
    const p2 = createSandboxAgentSessionProxy({ host: failing, remoteSessionId: "r", detachable: true })
    await expect(p2.extendDetachedLifetime?.()).resolves.toBeUndefined()
  })

  it("a proxy that is not detachable (device sandbox) exposes no detach surface", () => {
    const proxy = createSandboxAgentSessionProxy({ host: makeHost(), remoteSessionId: "r" })
    expect(proxy.detach).toBeUndefined()
    expect(proxy.detachRecord).toBeUndefined()
    expect(proxy.probeReattach).toBeUndefined()
    expect(proxy.resumeTurn).toBeUndefined()
  })
})

describe("sandbox proxy — probeReattach", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  const probe = async (): Promise<{ state: string; detail?: string }> => {
    const proxy = createSandboxAgentSessionProxy({
      host: makeHost(),
      remoteSessionId: "remote_1",
      detachable: true,
      initialTranscriptCursor: 3,
    })
    return (await proxy.probeReattach!()) as { state: string; detail?: string }
  }

  it("404 on the box session → gone", async () => {
    stubBox({ session: () => json({}, 404) })
    expect((await probe()).state).toBe("gone")
  })

  it("busy box session → busy", async () => {
    stubBox({ session: () => json({ busy: true, status: "running" }) })
    expect((await probe()).state).toBe("busy")
  })

  it("finished box session → ended", async () => {
    stubBox({ session: () => json({ busy: false, status: "killed" }) })
    expect((await probe()).state).toBe("ended")
  })

  it("idle box with unseen stream events → backlog, reading only after the saved seq", async () => {
    const seen: Array<string | null> = []
    stubBox({
      events: since => {
        seen.push(since)
        return json({ events: [{ seq: 4, kind: "text-delta", text: "x" }] })
      },
    })
    expect((await probe()).state).toBe("backlog")
    expect(seen).toEqual(["3"])
  })

  it("usage-only records after the cursor are not a backlog → idle", async () => {
    stubBox({ events: () => json({ events: [{ seq: 4, kind: "usage_snapshot" }] }) })
    expect((await probe()).state).toBe("idle")
  })

  it("transport failure → unreachable (never throws)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED")
      }),
    )
    const result = await probe()
    expect(result.state).toBe("unreachable")
    expect(result.detail).toContain("ECONNREFUSED")
  })
})

describe("sandbox proxy — resumeTurn", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it("replays from the saved seq into stream events WITHOUT prompting the box agent", async () => {
    const streamSince: Array<string | null> = []
    stubBox({
      session: () => json({ busy: true, status: "running" }),
      stream: since => {
        streamSince.push(since)
        return sseResponse([
          { seq: 6, ts: "t", kind: "text-delta", sessionId: "remote_1", text: "meanwhile\n" },
          { seq: 7, ts: "t", kind: "turn-end", sessionId: "remote_1", reason: "completed" },
        ])
      },
    })
    const host = makeHost()
    const proxy = createSandboxAgentSessionProxy({
      host,
      remoteSessionId: "remote_1",
      detachable: true,
      initialTranscriptCursor: 5,
    })
    await proxy.probeReattach!()

    const events = await collect(proxy.resumeTurn!())

    expect(streamSince).toEqual(["5"])
    expect(events).toEqual([
      { kind: "text-delta", text: "meanwhile\n" },
      { kind: "turn-end", reason: "completed" },
    ])
    expect(host.prompt).not.toHaveBeenCalled()
    expect(proxy.detachRecord?.()).toEqual({ remoteSessionId: "remote_1", transcriptSeq: 7 })
  })

  it("a backlog replay of an idle box ends quietly (no turn-end) instead of erroring or hanging busy", async () => {
    vi.useFakeTimers()
    stubBox({
      session: () => json({ busy: false, status: "running" }),
      events: () => json({ events: [{ seq: 6, kind: "text-delta", text: "x" }] }),
      stream: () => {
        // Replays the backlog, then tails forever with nothing more to say.
        const body = new ReadableStream<Uint8Array>({
          start(c) {
            const enc = new TextEncoder()
            c.enqueue(
              enc.encode(
                `data: ${JSON.stringify({ seq: 6, ts: "t", kind: "text-delta", sessionId: "r", text: "late\n" })}\n\n`,
              ),
            )
          },
        })
        return new Response(body, { status: 200 })
      },
    })
    const proxy = createSandboxAgentSessionProxy({
      host: makeHost(),
      remoteSessionId: "r",
      detachable: true,
      initialTranscriptCursor: 5,
    })
    expect((await proxy.probeReattach!()).state).toBe("backlog")

    const done = collect(proxy.resumeTurn!())
    await vi.advanceTimersByTimeAsync(11_000)
    const events = await done

    expect(events).toEqual([{ kind: "text-delta", text: "late\n" }])
  })
})

/* ------------------------------------------------------------------ */
/* Registry                                                            */
/* ------------------------------------------------------------------ */

interface FakeBoxSession extends AgentSessionLike {
  detach: ReturnType<typeof vi.fn>
  extendDetachedLifetime: ReturnType<typeof vi.fn>
  closeSpy: ReturnType<typeof vi.fn>
}

function fakeBoxSession(opts: {
  detachable?: boolean
  transcriptSeq?: number
  resumeEvents?: AgentStreamEvent[]
} = {}): FakeBoxSession {
  const closeSpy = vi.fn(async () => {})
  const detach = vi.fn(() => ({ remoteSessionId: "remote_1", transcriptSeq: opts.transcriptSeq ?? 4 }))
  const extendDetachedLifetime = vi.fn(async () => {})
  const session = {
    sessionId: "remote_1",
    async *send() {
      yield { kind: "turn-end", reason: "completed" } as AgentStreamEvent
    },
    async cancel() {},
    close: closeSpy,
    closeSpy,
    ...(opts.detachable === false
      ? {}
      : {
          detach,
          extendDetachedLifetime,
          detachRecord: () => ({ remoteSessionId: "remote_1", transcriptSeq: opts.transcriptSeq ?? 4 }),
          async *resumeTurn() {
            for (const ev of opts.resumeEvents ?? [{ kind: "turn-end", reason: "completed" } as AgentStreamEvent]) {
              yield ev
            }
          },
        }),
  }
  return session as unknown as FakeBoxSession
}

describe("registry — detach on shutdown, reattach on boot", () => {
  let tmp: string
  let persistPath: string
  let transcriptDir: string
  const prevLedger = process.env.AGENTPROTO_SANDBOX_LEDGER

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "sandbox-detach-"))
    persistPath = join(tmp, "sessions.json")
    transcriptDir = join(tmp, "transcripts")
    process.env.AGENTPROTO_SANDBOX_LEDGER = join(tmp, "sandboxes.json")
  })
  afterEach(() => {
    if (prevLedger === undefined) delete process.env.AGENTPROTO_SANDBOX_LEDGER
    else process.env.AGENTPROTO_SANDBOX_LEDGER = prevLedger
    rmSync(tmp, { recursive: true, force: true })
  })

  const newRegistry = (extra: { resumeAgent?: never } = {}) => {
    const bus = createSessionEventBus()
    const registry = createSessionsRegistry({ persistPath, transcriptDir, sessionEvents: bus, ...extra })
    return { registry, bus }
  }

  function spawnBox(
    registry: ReturnType<typeof createSessionsRegistry>,
    agentSession: AgentSessionLike,
    extra: { sandboxProvider?: string } = {},
  ): SessionDescriptor {
    return registry.spawnAgent({
      workspaceSlug: "default",
      cwd: tmp,
      agentSession,
      adapterSlug: "claude-code",
      remote: true,
      sandboxId: "sbx_1",
      sandboxProvider: extra.sandboxProvider ?? "e2b",
    })
  }

  function persistedRow(id: string): Record<string, unknown> {
    const snap = JSON.parse(readFileSync(persistPath, "utf8")) as { sessions: Array<Record<string, unknown>> }
    const row = snap.sessions.find(r => r.id === id)
    if (!row) throw new Error(`no persisted row ${id}`)
    return row
  }

  it("detachSandboxSessions detaches (never closes) a sandbox session, extends the box lifetime, and counts it", async () => {
    const { registry } = newRegistry()
    const box = fakeBoxSession()
    const desc = spawnBox(registry, box)

    expect(registry.sandboxSessionStats().attached).toBe(1)
    const { detached } = await registry.detachSandboxSessions()

    expect(detached).toBe(1)
    expect(box.detach).toHaveBeenCalledTimes(1)
    expect(box.extendDetachedLifetime).toHaveBeenCalledTimes(1)
    expect(box.closeSpy).not.toHaveBeenCalled()
    expect(registry.get(desc.id)).toMatchObject({ status: "running", hostDetached: true })
    // Idempotent: a second call detaches nothing more.
    expect((await registry.detachSandboxSessions()).detached).toBe(0)
    registry.shutdown()
  })

  it("shutdown persists the row as running + hostDetached + the reattach record, and closes no listener's box", async () => {
    const { registry } = newRegistry()
    const box = fakeBoxSession({ transcriptSeq: 9 })
    const desc = spawnBox(registry, box)

    await registry.detachSandboxSessions()
    registry.shutdown()

    expect(box.closeSpy).not.toHaveBeenCalled()
    const row = persistedRow(desc.id)
    expect(row.status).toBe("running")
    expect(row.hostDetached).toBe(true)
    expect(row.sandboxId).toBe("sbx_1")
    expect(row.sandboxReattach).toMatchObject({ remoteSessionId: "remote_1", transcriptSeq: 9 })
    expect(typeof (row.sandboxReattach as { detachedAt?: unknown }).detachedAt).toBe("string")
  })

  it("shutdown() alone (process-exit net) also detaches instead of killing", () => {
    const { registry } = newRegistry()
    const box = fakeBoxSession()
    const desc = spawnBox(registry, box)

    registry.shutdown()

    expect(box.detach).toHaveBeenCalledTimes(1)
    expect(box.closeSpy).not.toHaveBeenCalled()
    expect(persistedRow(desc.id)).toMatchObject({ status: "running", hostDetached: true })
  })

  it("a session whose proxy is not detachable (device / local) keeps the old behaviour: killed + daemon-restart", async () => {
    const { registry } = newRegistry()
    const plain = fakeBoxSession({ detachable: false })
    const desc = spawnBox(registry, plain, { sandboxProvider: "device:laptop" })

    expect((await registry.detachSandboxSessions()).detached).toBe(0)
    registry.shutdown()

    expect(plain.closeSpy).toHaveBeenCalledWith({ daemonShutdown: true })
    expect(persistedRow(desc.id)).toMatchObject({ status: "killed", endedReason: "daemon-restart" })
  })

  async function detachedSnapshot(box = fakeBoxSession()): Promise<string> {
    const first = newRegistry().registry
    const desc = spawnBox(first, box)
    await first.detachSandboxSessions()
    first.shutdown()
    return desc.id
  }

  it("a fresh registry lists the detached row as a reattach candidate, not resumable, with stats pending", async () => {
    const id = await detachedSnapshot()
    const { registry } = newRegistry()

    expect(registry.sandboxReattachCandidates().map(d => d.id)).toEqual([id])
    expect(isResumable(registry.get(id)!)).toBe(false)
    expect(registry.sandboxSessionStats()).toEqual({
      attached: 0,
      reattach: { detachedAtBoot: 1, reattached: 0, gone: 0, failed: 0, pending: 1 },
    })
    registry.shutdown()
  })

  it("attach keeps the SAME session id, binds the live proxy, announces it, and kills nothing", async () => {
    const id = await detachedSnapshot()
    const { registry, bus } = newRegistry()
    const resumed = vi.fn()
    bus.on("session:resumed", resumed)
    const live = fakeBoxSession()

    const outcome = registry.finishSandboxReattach(id, {
      kind: "attach",
      agentSession: live,
      probe: { state: "idle" },
    })

    expect(outcome).toEqual({ status: "reattached" })
    expect(registry.get(id)).toMatchObject({ id, status: "running" })
    expect(registry.get(id)?.hostDetached).toBeUndefined()
    expect(registry.get(id)?.sandboxReattach).toBeUndefined()
    expect(live.closeSpy).not.toHaveBeenCalled()
    expect(resumed).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: id, interrupted: false, resumedFrom: "daemon-restart" }),
    )
    expect(registry.sandboxReattachCandidates()).toEqual([])
    expect(registry.sandboxSessionStats().reattach).toMatchObject({ reattached: 1, pending: 0 })
    // Attached again ⇒ the NEXT restart detaches it too.
    expect(registry.sandboxSessionStats().attached).toBe(1)
    registry.shutdown()
  })

  it("attach of a busy box replays the in-flight turn through resumeTurn (no new prompt) and settles the row idle", async () => {
    const id = await detachedSnapshot()
    const { registry } = newRegistry()
    const live = fakeBoxSession({
      resumeEvents: [
        { kind: "text-delta", text: "while you were away\n" },
        { kind: "turn-end", reason: "completed" },
      ],
    })
    const sendSpy = vi.spyOn(live, "send")
    const records: Array<Record<string, unknown>> = []
    registry.subscribeToRecords(id, rec => records.push(rec))

    const outcome = registry.finishSandboxReattach(id, {
      kind: "attach",
      agentSession: live,
      probe: { state: "busy" },
    })

    expect(outcome).toEqual({ status: "reattached", resumedTurn: true })
    await vi.waitFor(() => expect(registry.get(id)?.busy).toBeFalsy())
    expect(sendSpy).not.toHaveBeenCalled()
    expect(JSON.stringify(records)).toContain("while you were away")
    registry.shutdown()
  })

  it("gone ends the row with sandbox_gone and counts it", async () => {
    const id = await detachedSnapshot()
    const { registry, bus } = newRegistry()
    const exited = vi.fn()
    bus.on("session:exited", exited)

    const outcome = registry.finishSandboxReattach(id, { kind: "gone", detail: "no such box" })

    expect(outcome).toEqual({ status: "gone" })
    expect(registry.get(id)).toMatchObject({ status: "killed", endedReason: "sandbox_gone" })
    expect(registry.get(id)?.hostDetached).toBeUndefined()
    expect(exited).toHaveBeenCalledTimes(1)
    expect(registry.sandboxSessionStats().reattach).toMatchObject({ gone: 1, pending: 0 })
    registry.shutdown()
  })

  it("ended (box session finished while the daemon was down) ends the row crashed", async () => {
    const id = await detachedSnapshot()
    const { registry } = newRegistry()

    expect(registry.finishSandboxReattach(id, { kind: "ended" })).toEqual({ status: "ended" })
    expect(registry.get(id)).toMatchObject({ status: "error", endedReason: "crashed" })
    registry.shutdown()
  })

  it("failed (transient) falls back to the plain daemon-restart ghost, still resumable", async () => {
    const id = await detachedSnapshot()
    const { registry } = newRegistry()

    expect(registry.finishSandboxReattach(id, { kind: "failed", detail: "timeout" })).toEqual({
      status: "failed",
    })
    expect(registry.get(id)).toMatchObject({ status: "killed", endedReason: "daemon-restart" })
    expect(registry.get(id)?.hostDetached).toBeUndefined()
    expect(registry.sandboxSessionStats().reattach).toMatchObject({ failed: 1, pending: 0 })
    registry.shutdown()
  })

  it("resolving an unknown or already-resolved row is skipped, and an unneeded live proxy is closed", async () => {
    const id = await detachedSnapshot()
    const { registry } = newRegistry()
    registry.finishSandboxReattach(id, { kind: "gone" })
    const live = fakeBoxSession()

    expect(
      registry.finishSandboxReattach(id, { kind: "attach", agentSession: live, probe: { state: "idle" } }),
    ).toEqual({ status: "skipped" })
    expect(registry.finishSandboxReattach("nope", { kind: "gone" })).toEqual({ status: "skipped" })
    expect(live.closeSpy).toHaveBeenCalledTimes(1)
    registry.shutdown()
  })

  it("a crash (no graceful shutdown) is recoverable: snapshots keep the reattach record fresh", async () => {
    const { registry } = newRegistry()
    const box = fakeBoxSession({ transcriptSeq: 12 })
    const desc = spawnBox(registry, box)
    // Let the debounced persist land without ever calling shutdown().
    await registry.settlePendingWrites()
    await vi.waitFor(
      () => {
        const row = persistedRow(desc.id)
        expect(row.sandboxReattach).toMatchObject({ remoteSessionId: "remote_1", transcriptSeq: 12 })
      },
      { timeout: 5_000, interval: 100 },
    )

    const { registry: next } = newRegistry()
    expect(next.sandboxReattachCandidates().map(d => d.id)).toEqual([desc.id])
    next.shutdown()
    registry.shutdown()
  })
})

/* ------------------------------------------------------------------ */
/* Boot pass                                                           */
/* ------------------------------------------------------------------ */

describe("runSandboxReattachPass", () => {
  let tmp: string
  let persistPath: string
  let ledgerPath: string
  const prevLedger = process.env.AGENTPROTO_SANDBOX_LEDGER

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "sandbox-reattach-pass-"))
    persistPath = join(tmp, "sessions.json")
    ledgerPath = join(tmp, "sandboxes.json")
    process.env.AGENTPROTO_SANDBOX_LEDGER = ledgerPath
    providerMock.create.mockReset()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    if (prevLedger === undefined) delete process.env.AGENTPROTO_SANDBOX_LEDGER
    else process.env.AGENTPROTO_SANDBOX_LEDGER = prevLedger
    rmSync(tmp, { recursive: true, force: true })
  })

  function seedDetached(rows: Array<{ id: string; sandboxId?: string; provider?: string }>): void {
    writeFileSync(
      persistPath,
      JSON.stringify({
        savedAt: "2026-07-23T00:00:00Z",
        sessions: rows.map(r => ({
          id: r.id,
          kind: "agent-cli",
          workspaceSlug: "default",
          command: "claude (agent)",
          pid: null,
          status: "running",
          startedAt: "2026-07-23T00:00:00Z",
          busy: false,
          adapterSlug: "claude-code",
          adapterSessionId: "remote_1",
          cwd: tmp,
          remote: true,
          sandboxId: r.sandboxId ?? "sbx_1",
          sandboxProvider: r.provider ?? "e2b",
          hostDetached: true,
          sandboxReattach: {
            remoteSessionId: "remote_1",
            transcriptSeq: 5,
            detachedAt: "2026-07-23T00:00:00Z",
          },
        })),
      }),
    )
  }

  const newRegistry = () =>
    createSessionsRegistry({
      persistPath,
      transcriptDir: join(tmp, "transcripts"),
      sessionEvents: createSessionEventBus(),
    })

  const resolver: SandboxProviderResolver = async slug =>
    slug === "e2b" ? ({ provider: { id: "e2b" } } as never) : null

  it("reconnects to the saved sandboxId (never boots), binds the live proxy to the same id, and tallies it", async () => {
    seedDetached([{ id: "s1" }])
    providerMock.create.mockResolvedValue(makeHost())
    stubBox({ session: () => json({ busy: false, status: "running" }) })
    const registry = newRegistry()

    const summary = await runSandboxReattachPass({ registry, resolveSandboxProvider: resolver })

    expect(providerMock.create).toHaveBeenCalledWith(expect.objectContaining({ sandboxId: "sbx_1" }))
    expect(summary).toEqual({ candidates: 1, reattached: 1, gone: 0, ended: 0, failed: 0 })
    expect(registry.get("s1")).toMatchObject({ id: "s1", status: "running" })
    expect(registry.get("s1")?.hostDetached).toBeUndefined()
    // Reattached ⇒ detachable again for the next restart.
    expect(registry.sandboxSessionStats().attached).toBe(1)
    registry.shutdown()
  })

  it("a box that no longer exists ends the row sandbox_gone and records it in the ledger", async () => {
    seedDetached([{ id: "s1" }])
    providerMock.create.mockRejectedValue(new SandboxBoxGoneError("sbx_1"))
    const now = new Date().toISOString()
    upsertSandboxLedger({
      sandboxId: "sbx_1",
      provider: "e2b",
      state: "connected",
      createdAt: now,
      updatedAt: now,
    })
    const registry = newRegistry()

    const summary = await runSandboxReattachPass({ registry, resolveSandboxProvider: resolver })

    expect(summary).toMatchObject({ candidates: 1, gone: 1, reattached: 0 })
    expect(registry.get("s1")).toMatchObject({ status: "killed", endedReason: "sandbox_gone" })
    expect(readSandboxLedger().find(e => e.sandboxId === "sbx_1")?.state).toBe("gone")
    registry.shutdown()
  })

  it("a box whose session is gone (404 on the box daemon) ends sandbox_gone and tears the box down", async () => {
    seedDetached([{ id: "s1" }])
    const host = makeHost()
    providerMock.create.mockResolvedValue(host)
    stubBox({ session: () => json({}, 404) })
    const registry = newRegistry()

    const summary = await runSandboxReattachPass({ registry, resolveSandboxProvider: resolver })

    expect(summary).toMatchObject({ gone: 1, reattached: 0 })
    expect(registry.get("s1")).toMatchObject({ endedReason: "sandbox_gone" })
    expect(host.stop).toHaveBeenCalled()
    registry.shutdown()
  })

  it("an unreachable box or unresolvable provider leaves the daemon-restart ghost (failed), without tearing anything down", async () => {
    seedDetached([{ id: "s1" }, { id: "s2", provider: "nope" }])
    const host = makeHost()
    providerMock.create.mockResolvedValue(host)
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED")
      }),
    )
    const registry = newRegistry()

    const summary = await runSandboxReattachPass({ registry, resolveSandboxProvider: resolver })

    expect(summary).toMatchObject({ candidates: 2, failed: 2, reattached: 0 })
    expect(registry.get("s1")).toMatchObject({ status: "killed", endedReason: "daemon-restart" })
    expect(registry.get("s2")).toMatchObject({ status: "killed", endedReason: "daemon-restart" })
    expect(host.kill).not.toHaveBeenCalled()
    expect(host.stop).not.toHaveBeenCalled()
    registry.shutdown()
  })

  it("does nothing when no row was detached", async () => {
    writeFileSync(persistPath, JSON.stringify({ savedAt: "2026-07-23T00:00:00Z", sessions: [] }))
    const registry = newRegistry()
    expect(await runSandboxReattachPass({ registry, resolveSandboxProvider: resolver })).toEqual({
      candidates: 0,
      reattached: 0,
      gone: 0,
      ended: 0,
      failed: 0,
    })
    expect(providerMock.create).not.toHaveBeenCalled()
    registry.shutdown()
  })

  /* ------------------------------------------------------------------ */
  /* Per-row deadline                                                    */
  /* ------------------------------------------------------------------ */

  const never = <T,>(): Promise<T> => new Promise<T>(() => {})

  it("a provider whose connect never resolves ends the row failed with the timeout detail, pending 0", async () => {
    seedDetached([{ id: "s1" }])
    providerMock.create.mockImplementation(() => never<ReturnType<typeof makeHost>>())
    const registry = newRegistry()
    const finish = vi.spyOn(registry, "finishSandboxReattach")

    const summary = await runSandboxReattachPass({
      registry,
      resolveSandboxProvider: resolver,
      timeoutMs: 40,
    })

    expect(summary).toEqual({ candidates: 1, reattached: 0, gone: 0, ended: 0, failed: 1 })
    expect(finish).toHaveBeenCalledWith("s1", {
      kind: "failed",
      detail: "reattach timed out after 40ms",
    })
    // Row falls back to the plain daemon-restart ghost (never left pending).
    expect(registry.get("s1")).toMatchObject({ status: "killed", endedReason: "daemon-restart" })
    expect(registry.sandboxSessionStats().reattach).toMatchObject({
      detachedAtBoot: 1,
      failed: 1,
      pending: 0,
    })
    registry.shutdown()
  })

  it("a timed-out row whose provider still says the box is gone ends sandbox_gone", async () => {
    seedDetached([{ id: "s1" }])
    providerMock.create.mockImplementation(() => never<ReturnType<typeof makeHost>>())
    const goneResolver: SandboxProviderResolver = async slug =>
      slug === "e2b"
        ? ({
            provider: { id: "e2b", probe: vi.fn(async () => ({ alive: false })) },
          } as never)
        : null
    // Real boot records the box in the ledger before reattach runs.
    const now = new Date().toISOString()
    upsertSandboxLedger({
      sandboxId: "sbx_1",
      provider: "e2b",
      state: "connected",
      createdAt: now,
      updatedAt: now,
    })
    const registry = newRegistry()

    const summary = await runSandboxReattachPass({
      registry,
      resolveSandboxProvider: goneResolver,
      timeoutMs: 40,
    })

    expect(summary).toMatchObject({ candidates: 1, gone: 1, failed: 0, reattached: 0 })
    expect(registry.get("s1")).toMatchObject({ status: "killed", endedReason: "sandbox_gone" })
    expect(readSandboxLedger().find(e => e.sandboxId === "sbx_1")?.state).toBe("gone")
    expect(registry.sandboxSessionStats().reattach).toMatchObject({ pending: 0 })
    registry.shutdown()
  })

  it("a deadline that fires with the host already open detaches the half-open handle — never kills the box", async () => {
    seedDetached([{ id: "s1" }])
    const host = makeHost()
    providerMock.create.mockResolvedValue(host)
    // The box probe never answers: only the row deadline can settle this.
    vi.stubGlobal(
      "fetch",
      vi.fn(() => never<Response>()),
    )
    const registry = newRegistry()

    const summary = await runSandboxReattachPass({
      registry,
      resolveSandboxProvider: resolver,
      timeoutMs: 40,
    })

    expect(summary).toMatchObject({ candidates: 1, failed: 1, reattached: 0 })
    expect(registry.sandboxSessionStats().reattach).toMatchObject({ pending: 0 })
    // detach() only drops the MCP connection + timers…
    expect(host.close).toHaveBeenCalled()
    // …the live box is left exactly as it was.
    expect(host.stop).not.toHaveBeenCalled()
    expect(host.kill).not.toHaveBeenCalled()
    registry.shutdown()
  })

  it("honours an explicit timeoutMs over the 30s default", async () => {
    seedDetached([{ id: "s1" }])
    providerMock.create.mockImplementation(() => never<ReturnType<typeof makeHost>>())
    const registry = newRegistry()

    const startedAt = Date.now()
    await runSandboxReattachPass({
      registry,
      resolveSandboxProvider: resolver,
      timeoutMs: 700,
      concurrency: 1,
    })
    const elapsed = Date.now() - startedAt

    // Settles at the configured deadline, not at DEFAULT_REATTACH_TIMEOUT_MS.
    expect(elapsed).toBeGreaterThanOrEqual(600)
    expect(elapsed).toBeLessThan(15_000)
    expect(registry.sandboxSessionStats().reattach).toMatchObject({ pending: 0 })
    registry.shutdown()
  }, 20_000)
})
