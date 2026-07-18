import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { SessionStore, type Scheduler } from "./sessionStore.js"
import type { DaemonClient } from "../client/daemonClient.js"
import type { SessionDescriptor, SessionStreamLine } from "../client/types.js"

function session(over: Partial<SessionDescriptor> = {}): SessionDescriptor {
  return {
    id: "s1",
    kind: "agent-cli",
    workspaceSlug: "ws",
    command: "cmd",
    pid: 1,
    status: "running",
    startedAt: "2026-01-01T00:00:00Z",
    ...over,
  }
}

function createFakeClient(): DaemonClient & {
  listSessions: ReturnType<typeof vi.fn>
  listPermissions: ReturnType<typeof vi.fn>
  sessionEventsPoll: ReturnType<typeof vi.fn>
  resolveToken: ReturnType<typeof vi.fn>
} {
  return {
    url: "http://127.0.0.1:18790",
    listSessions: vi.fn().mockResolvedValue([]),
    listPermissions: vi.fn().mockResolvedValue([]),
    sessionEventsPoll: vi.fn().mockResolvedValue({ events: [], nextCursor: 0 }),
    resolveToken: vi.fn().mockResolvedValue(undefined),
  } as unknown as DaemonClient & {
    listSessions: ReturnType<typeof vi.fn>
    listPermissions: ReturnType<typeof vi.fn>
    sessionEventsPoll: ReturnType<typeof vi.fn>
    resolveToken: ReturnType<typeof vi.fn>
  }
}

/**
 * Test scheduler with manually controlled sleeps. The poll loop is driven by
 * resolving queued sleeps one at a time, so tests are bounded and never need
 * to advance fake time across a self-rescheduling background loop.
 */
class ManualScheduler implements Scheduler {
  private readonly queue: Array<{ ms: number; resolve: () => void }> = []

  sleep(ms: number): { promise: Promise<void>; cancel(): void } {
    let resolveFn: () => void
    const promise = new Promise<void>((r) => {
      resolveFn = r
    })
    const entry = { ms, resolve: resolveFn! }
    this.queue.push(entry)
    return {
      promise,
      cancel: () => {
        const idx = this.queue.indexOf(entry)
        if (idx !== -1) this.queue.splice(idx, 1)
        resolveFn!()
      },
    }
  }

  get pending(): ReadonlyArray<{ ms: number }> {
    return this.queue
  }

  resolveNext(): number | undefined {
    const entry = this.queue.shift()
    entry?.resolve()
    return entry?.ms
  }

  resolveAll(): void {
    while (this.queue.length > 0) this.resolveNext()
  }
}

function createTracingFetch(): {
  fetchImpl: typeof fetch
  cancels: string[]
  deliver: (url: string, event: unknown) => void
} {
  const controllers = new Map<string, ReadableStreamDefaultController<Uint8Array>>()
  const cancels: string[] = []
  const encoder = new TextEncoder()

  const fetchImpl = vi.fn((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString()
    let streamController: ReadableStreamDefaultController<Uint8Array> | undefined
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller
        controllers.set(url, controller)
      },
      cancel() {
        cancels.push(url)
      },
    })
    const signal = init?.signal
    if (signal) {
      const onAbort = () => {
        cancels.push(url)
        streamController?.error(new DOMException("Aborted", "AbortError"))
      }
      if (signal.aborted) {
        onAbort()
      } else {
        signal.addEventListener("abort", onAbort, { once: true })
      }
    }
    return Promise.resolve(
      new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } }),
    )
  }) as unknown as typeof fetch

  return {
    fetchImpl,
    cancels,
    deliver(url: string, event: unknown) {
      const controller = controllers.get(url)
      if (controller) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`))
      }
    },
  }
}

function baseSessionUrl(id: string): string {
  return `http://127.0.0.1:18790/sessions/${id}/stream`
}

/** Yield to the real event loop so pending promise chains settle. */
async function flush(): Promise<void> {
  await new Promise<void>((r) => setTimeout(r, 0))
}

describe("SessionStore — poll loop", () => {
  it("throttles empty session_events_poll calls with a bounded idle delay", async () => {
    const client = createFakeClient()
    const scheduler = new ManualScheduler()
    const store = new SessionStore(client, 5000, scheduler)
    store.start()

    await flush()
    expect(client.sessionEventsPoll).toHaveBeenCalledTimes(1)
    expect(scheduler.pending.length).toBe(1)
    expect(scheduler.pending[0]!.ms).toBe(250)

    // Idle backoff starts at 250ms then doubles.
    scheduler.resolveNext()
    await flush()
    expect(client.sessionEventsPoll).toHaveBeenCalledTimes(2)
    expect(scheduler.pending.length).toBe(1)
    expect(scheduler.pending[0]!.ms).toBe(500)

    scheduler.resolveNext()
    await flush()
    expect(client.sessionEventsPoll).toHaveBeenCalledTimes(3)

    store.dispose()
  })

  it("recovers from fallback when refreshAll succeeds", async () => {
    const client = createFakeClient()
    client.sessionEventsPoll.mockRejectedValue(new Error("daemon down"))
    const scheduler = new ManualScheduler()
    const store = new SessionStore(client, 5000, scheduler)
    store.start()

    await flush()
    expect(client.sessionEventsPoll).toHaveBeenCalledTimes(1)
    expect(scheduler.pending[0]!.ms).toBe(2_000)

    // Second failure — 4000ms backoff.
    scheduler.resolveNext()
    await flush()
    expect(client.sessionEventsPoll).toHaveBeenCalledTimes(2)
    expect(scheduler.pending[0]!.ms).toBe(4_000)

    // Third failure trips the health threshold. The loop should switch to the
    // fallback refresh path and then resume normal event polling.
    scheduler.resolveNext()
    await flush()
    // After the threshold is crossed the loop immediately resets health via the
    // fallback refresh and resumes event polling, so the exact call count at
    // this microtask boundary is not stable. Assert the properties that matter:
    // at least three poll attempts have been made and the fallback path ran.
    expect(client.sessionEventsPoll.mock.calls.length).toBeGreaterThanOrEqual(3)
    expect(client.listSessions).toHaveBeenCalledTimes(2) // boot + fallback

    client.sessionEventsPoll.mockResolvedValue({ events: [], nextCursor: 1 })
    scheduler.resolveNext()
    await flush()
    expect(client.listSessions).toHaveBeenCalledTimes(2) // still just boot + fallback
    expect(client.sessionEventsPoll.mock.calls.length).toBeGreaterThan(3) // resumed

    // Polling continues after recovery.
    const previousPollCount = client.sessionEventsPoll.mock.calls.length
    scheduler.resolveNext()
    await flush()
    expect(client.sessionEventsPoll.mock.calls.length).toBeGreaterThan(previousPollCount)

    store.dispose()
  })

  it("does not apply boot snapshots, fire changes, or start polling when disposed during initial refresh", async () => {
    const client = createFakeClient()
    let resolveBoot: (sessions: SessionDescriptor[]) => void = () => {}
    client.listSessions.mockImplementation(
      () => new Promise<SessionDescriptor[]>((resolve) => {
        resolveBoot = resolve
      }),
    )
    client.listPermissions.mockResolvedValue([])

    const scheduler = new ManualScheduler()
    const store = new SessionStore(client, 5000, scheduler)
    const fireSpy = vi.spyOn((store as any)._onDidChange, "fire")

    store.start()
    await flush()
    expect(client.listSessions).toHaveBeenCalledTimes(1)
    expect(client.sessionEventsPoll).not.toHaveBeenCalled()

    store.dispose()
    resolveBoot([session()])
    await flush()

    expect(store.sessions).toEqual([])
    expect(store.permissions).toEqual([])
    expect(fireSpy.mock.calls.length).toBe(0)
    expect(client.listPermissions).not.toHaveBeenCalled()
    expect(client.sessionEventsPoll).not.toHaveBeenCalled()
    expect(scheduler.pending.length).toBe(0)

    fireSpy.mockRestore()
  })
})

describe("SessionStore — showArchived", () => {
  it("defaults to hiding archived sessions — listSessions() is called with includeArchived: false", async () => {
    const client = createFakeClient()
    const store = new SessionStore(client, 5000, new ManualScheduler())

    expect(store.showArchived).toBe(false)
    await store.refreshAll()
    expect(client.listSessions).toHaveBeenLastCalledWith({ includeArchived: false })

    store.dispose()
  })

  it("setShowArchived(true) re-fetches immediately with includeArchived: true", async () => {
    const client = createFakeClient()
    const store = new SessionStore(client, 5000, new ManualScheduler())
    await store.refreshAll()
    client.listSessions.mockClear()

    store.setShowArchived(true)
    await flush()

    expect(store.showArchived).toBe(true)
    expect(client.listSessions).toHaveBeenCalledWith({ includeArchived: true })

    store.dispose()
  })

  it("setShowArchived is a no-op (no redundant fetch) when the value doesn't change", async () => {
    const client = createFakeClient()
    const store = new SessionStore(client, 5000, new ManualScheduler())
    await store.refreshAll()
    client.listSessions.mockClear()

    store.setShowArchived(false) // already false
    await flush()

    expect(client.listSessions).not.toHaveBeenCalled()

    store.dispose()
  })
})

describe("SessionStore — debounced refresh", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("coalesces lifecycle events into a single authoritative session refresh", async () => {
    const client = createFakeClient()
    client.sessionEventsPoll.mockResolvedValue({
      events: [
        { type: "session:turn-end", sessionId: "s1" },
        { type: "session:turn-end", sessionId: "s1" },
      ],
      nextCursor: 2,
    })
    client.listSessions.mockResolvedValue([session({ busy: true, lastActivityAt: "t" })])

    const scheduler = new ManualScheduler()
    const store = new SessionStore(client, 5000, scheduler)
    store.start()

    // Drain the boot microtasks and the first poll.
    await vi.advanceTimersByTimeAsync(0)
    expect(client.listSessions).toHaveBeenCalledTimes(1) // boot

    // The poll is now sleeping on the manual scheduler. The 150ms debounce
    // timer is the only fake timer in play.
    client.listSessions.mockResolvedValue([session({ busy: false, lastActivityAt: "t" })])
    await vi.advanceTimersByTimeAsync(150)
    expect(client.listSessions).toHaveBeenCalledTimes(2) // debounced refresh
    store.dispose()
  })

  it("snapshots on a clock, so a session started elsewhere appears without a manual refresh", async () => {
    const client = createFakeClient()
    client.sessionEventsPoll.mockResolvedValue({ events: [], nextCursor: 0 })
    client.listSessions.mockResolvedValue([])

    const scheduler = new ManualScheduler()
    const store = new SessionStore(client, 5000, scheduler)
    store.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(client.listSessions).toHaveBeenCalledTimes(1) // boot

    // The daemon announces turn-end/awaiting-input/exited/command-done and
    // nothing else. A session that has just started has emitted none of them,
    // so the event-driven descriptor refresh can never learn it exists — which
    // is why the sidebar needed a human to click Refresh.
    client.listSessions.mockResolvedValue([session({ id: "started-elsewhere" })])

    // Five idle polls: 250 + 500 + 1000 + 2000 + 2000 = 5750ms, crossing the
    // 5000ms pollIntervalMs. No events ever arrive.
    for (let i = 0; i < 5; i++) {
      scheduler.resolveNext()
      await vi.advanceTimersByTimeAsync(0)
    }
    await vi.advanceTimersByTimeAsync(150) // the debounce

    expect(client.listSessions).toHaveBeenCalledTimes(2)
    expect(store.sessions.map(s => s.id)).toContain("started-elsewhere")
    store.dispose()
  })

  it("does not snapshot before the interval has elapsed", async () => {
    // The point is a floor on staleness, not a poll on every tick.
    const client = createFakeClient()
    client.sessionEventsPoll.mockResolvedValue({ events: [], nextCursor: 0 })

    const scheduler = new ManualScheduler()
    const store = new SessionStore(client, 5000, scheduler)
    store.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(client.listSessions).toHaveBeenCalledTimes(1) // boot

    // Two polls — 750ms of the 5000ms budget.
    for (let i = 0; i < 2; i++) {
      scheduler.resolveNext()
      await vi.advanceTimersByTimeAsync(0)
    }
    await vi.advanceTimersByTimeAsync(150)

    expect(client.listSessions).toHaveBeenCalledTimes(1)
    store.dispose()
  })

  it("retries a failed descriptor refresh with bounded backoff", async () => {
    const client = createFakeClient()
    client.sessionEventsPoll.mockResolvedValue({
      events: [{ type: "session:turn-end", sessionId: "s1" }],
      nextCursor: 1,
    })
    client.listSessions
      .mockResolvedValueOnce([]) // boot
      .mockRejectedValueOnce(new Error("down")) // debounced refresh fails
      .mockResolvedValueOnce([session()]) // retry succeeds

    const scheduler = new ManualScheduler()
    const store = new SessionStore(client, 5000, scheduler)
    store.start()

    await vi.advanceTimersByTimeAsync(0)
    expect(client.listSessions).toHaveBeenCalledTimes(1) // boot

    // Debounce fires at 150ms and fails; retry is scheduled for 150ms later.
    await vi.advanceTimersByTimeAsync(150)
    expect(client.listSessions).toHaveBeenCalledTimes(2)

    await vi.advanceTimersByTimeAsync(150)
    expect(client.listSessions).toHaveBeenCalledTimes(3)

    store.dispose()
  })

  it("does not apply a descriptor snapshot or schedule a retry after disposal", async () => {
    const client = createFakeClient()
    let resolveRefresh: (sessions: SessionDescriptor[]) => void = () => {}
    client.listSessions
      .mockResolvedValueOnce([]) // boot
      .mockImplementationOnce(
        () => new Promise((resolve) => {
          resolveRefresh = resolve
        }),
      )

    client.sessionEventsPoll
      .mockResolvedValueOnce({
        events: [{ type: "session:turn-end", sessionId: "s1" }],
        nextCursor: 1,
      })
      .mockResolvedValue({ events: [], nextCursor: 1 })

    const scheduler = new ManualScheduler()
    const store = new SessionStore(client, 5000, scheduler)
    const fireSpy = vi.spyOn((store as any)._onDidChange, "fire")

    store.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(client.listSessions).toHaveBeenCalledTimes(1) // boot

    scheduler.resolveNext()
    await vi.advanceTimersByTimeAsync(150)
    expect(client.listSessions).toHaveBeenCalledTimes(2) // refresh in flight

    const fireCountAtDispose = fireSpy.mock.calls.length
    store.dispose()

    resolveRefresh([session()])
    await vi.advanceTimersByTimeAsync(0)

    expect(fireSpy.mock.calls.length).toBe(fireCountAtDispose)
    expect(vi.getTimerCount()).toBe(0)

    fireSpy.mockRestore()
  })

  it("does not schedule a retry or fire changes when an in-flight refresh rejects after disposal", async () => {
    const client = createFakeClient()
    let rejectRefresh: (reason?: unknown) => void = () => {}
    client.listSessions
      .mockResolvedValueOnce([]) // boot
      .mockImplementationOnce(
        () => new Promise((_resolve, reject) => {
          rejectRefresh = reject
        }),
      )

    client.sessionEventsPoll
      .mockResolvedValueOnce({
        events: [{ type: "session:turn-end", sessionId: "s1" }],
        nextCursor: 1,
      })
      .mockResolvedValue({ events: [], nextCursor: 1 })

    const scheduler = new ManualScheduler()
    const store = new SessionStore(client, 5000, scheduler)
    const fireSpy = vi.spyOn((store as any)._onDidChange, "fire")

    store.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(client.listSessions).toHaveBeenCalledTimes(1) // boot

    scheduler.resolveNext()
    await vi.advanceTimersByTimeAsync(150)
    expect(client.listSessions).toHaveBeenCalledTimes(2) // refresh in flight

    const fireCountAtDispose = fireSpy.mock.calls.length
    store.dispose()

    rejectRefresh(new Error("gone"))
    await vi.advanceTimersByTimeAsync(0)

    expect(fireSpy.mock.calls.length).toBe(fireCountAtDispose)
    expect(vi.getTimerCount()).toBe(0)
    expect(scheduler.pending.length).toBe(0)

    fireSpy.mockRestore()
  })
})

describe("SessionStore — focusOutput", () => {
  let originalFetch: typeof fetch

  beforeEach(() => {
    originalFetch = globalThis.fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it("does not start the SSE stream if disposed before token resolves", async () => {
    const { fetchImpl, cancels } = createTracingFetch()
    globalThis.fetch = fetchImpl

    const client = createFakeClient()
    let resolveToken: (token: string) => void = () => {}
    client.resolveToken.mockImplementation(
      () => new Promise<string>((r) => {
        resolveToken = r
      }),
    )

    const store = new SessionStore(client, 5000, new ManualScheduler())
    const sub = store.focusOutput("s1", { onLine: () => {} })
    sub.dispose()

    resolveToken("token")
    await flush()

    expect(fetchImpl).not.toHaveBeenCalled()
    expect(cancels).toEqual([])
    store.dispose()
  })

  it("closes all active focus streams when the store is disposed", async () => {
    const { fetchImpl, cancels } = createTracingFetch()
    globalThis.fetch = fetchImpl

    const client = createFakeClient()
    client.resolveToken.mockResolvedValue("token")

    const store = new SessionStore(client, 5000, new ManualScheduler())
    const sub1 = store.focusOutput("s1", { onLine: () => {} })
    const sub2 = store.focusOutput("s2", { onLine: () => {} })

    await flush()
    const s1Url = baseSessionUrl("s1")
    const s2Url = baseSessionUrl("s2")

    store.dispose()
    expect(cancels).toContain(s1Url)
    expect(cancels).toContain(s2Url)

    // Individual disposables remain idempotent.
    sub1.dispose()
    sub2.dispose()
  })

  it("keeps a newer focus stream alive when an older disposable is closed", async () => {
    const { fetchImpl, cancels, deliver } = createTracingFetch()
    globalThis.fetch = fetchImpl

    const client = createFakeClient()
    client.resolveToken.mockResolvedValue("token")

    const store = new SessionStore(client, 5000, new ManualScheduler())
    const lines1: SessionStreamLine[] = []
    const lines2: SessionStreamLine[] = []

    const sub1 = store.focusOutput("s1", {
      onLine: (line) => lines1.push(line),
    })
    const sub2 = store.focusOutput("s2", {
      onLine: (line) => lines2.push(line),
    })

    await flush()
    const s1Url = baseSessionUrl("s1")
    const s2Url = baseSessionUrl("s2")
    expect(fetchImpl).toHaveBeenCalledTimes(2)

    deliver(s1Url, { line: "s1-before" })
    deliver(s2Url, { line: "s2-before" })
    await flush()
    expect(lines1).toContainEqual({ line: "s1-before" })
    expect(lines2).toContainEqual({ line: "s2-before" })

    sub1.dispose()
    await flush()
    expect(cancels).toContain(s1Url)
    expect(cancels).not.toContain(s2Url)

    // The s2 stream keeps receiving after s1 is closed.
    deliver(s2Url, { line: "s2-after" })
    await flush()
    expect(lines2).toContainEqual({ line: "s2-after" })

    sub2.dispose()
    store.dispose()
  })
})

describe("SessionStore — optimistic rows", () => {
  it("shows a row for a spawn the daemon hasn't acknowledged yet", () => {
    const client = createFakeClient()
    const store = new SessionStore(client, 5000, new ManualScheduler())

    const pendingId = store.addPending({ label: "reviewer", adapterSlug: "claude-code" })

    expect(store.sessions.map(s => s.label)).toContain("reviewer")
    expect(pendingId).toMatch(/^pending:/)
    store.dispose()
  })

  it("fires a change so the tree paints the row at once", () => {
    const client = createFakeClient()
    const store = new SessionStore(client, 5000, new ManualScheduler())
    const seen = vi.fn()
    store.onDidChange(seen)

    store.addPending({ label: "reviewer" })

    expect(seen).toHaveBeenCalledTimes(1)
    store.dispose()
  })

  it("survives a snapshot that doesn't know about it yet", async () => {
    // The whole reason pending rows live outside `sessions`: listSessions()
    // replaces that map wholesale, and the spawn is in flight precisely
    // BECAUSE the daemon can't report it yet. A row erased by the next poll
    // would flicker out a moment after appearing.
    const client = createFakeClient()
    client.listSessions.mockResolvedValue([session({ id: "unrelated" })])
    const store = new SessionStore(client, 5000, new ManualScheduler())

    store.addPending({ label: "reviewer" })
    await store.refreshAll()

    expect(store.sessions.map(s => s.label)).toContain("reviewer")
    expect(store.sessions.map(s => s.id)).toContain("unrelated")
    store.dispose()
  })

  it("drops the row once the spawn resolves", () => {
    const client = createFakeClient()
    const store = new SessionStore(client, 5000, new ManualScheduler())

    const pendingId = store.addPending({ label: "reviewer" })
    store.resolvePending(pendingId)

    expect(store.sessions).toHaveLength(0)
    store.dispose()
  })

  it("resolving twice is harmless and fires once", () => {
    // spawn.ts resolves in a `finally`; nothing should depend on it running
    // exactly once.
    const client = createFakeClient()
    const store = new SessionStore(client, 5000, new ManualScheduler())
    const pendingId = store.addPending({ label: "reviewer" })

    const seen = vi.fn()
    store.onDidChange(seen)
    store.resolvePending(pendingId)
    store.resolvePending(pendingId)

    expect(seen).toHaveBeenCalledTimes(1)
    store.dispose()
  })

  it("keeps concurrent spawns apart", () => {
    const client = createFakeClient()
    const store = new SessionStore(client, 5000, new ManualScheduler())

    const first = store.addPending({ label: "one" })
    const second = store.addPending({ label: "two" })
    store.resolvePending(first)

    expect(store.sessions.map(s => s.label)).toEqual(["two"])
    expect(first).not.toBe(second)
    store.dispose()
  })
})
