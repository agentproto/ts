/**
 * Unit tests for SentinelRuntime (AIP-60 step 2).
 *
 * The runtime's `registry` dependency is structural (`{sendMessage}`), same
 * as `supervisor-notify.ts`'s `SupervisorNotifyRegistry` — these tests stub
 * it directly rather than standing up a full `SessionsRegistry`, since
 * nothing here depends on genuine descriptor/busy-flag shape (unlike
 * `supervisor-notify.test.ts`, which needs `markCrashed`).
 */

import { describe, expect, it, vi } from "vitest"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createSentinelStore, type Sentinel, type SentinelStore } from "../sentinel-store.js"
import { createSentinelRuntime, type SentinelRuntimeRegistry } from "../sentinel-runtime.js"
import { createFakeSentinelProvider, makeFakeEvent } from "../sentinel-providers/fake.js"
import { singleMatch, type SentinelMatchClause, type SentinelProviderHandle } from "../sentinel-providers/types.js"
import { SessionNotAliveError, type SendMessageResult } from "../sessions.js"
import type { SessionMessage } from "../session-message.js"

// ── Test doubles ─────────────────────────────────────────────────────

interface StubRegistry extends SentinelRuntimeRegistry {
  calls: Array<{ msg: SessionMessage; opts?: { source?: string; origin?: string } }>
}

function stubRegistry(
  impl: (msg: SessionMessage, calls: StubRegistry["calls"]) => Promise<SendMessageResult>,
): StubRegistry {
  const calls: StubRegistry["calls"] = []
  return {
    calls,
    async sendMessage(msg, opts) {
      calls.push({ msg, opts })
      return impl(msg, calls)
    },
  }
}

const okResult = (): SendMessageResult => ({
  messageId: "msg_test",
  delivered: { via: "turn" },
  queued: false,
  urgencyApplied: "next-turn",
})

function newSentinel(
  store: SentinelStore,
  overrides?: {
    sessionId?: string
    urgency?: "fyi" | "next-turn" | "steer" | "interrupt"
    subject?: string
    match?: SentinelMatchClause[]
    until?: Sentinel["spec"]["until"]
    provider?: string
  },
): Sentinel {
  const subject = overrides?.subject ?? "fake:widget-1"
  const match = overrides?.match ?? singleMatch(subject)
  return store.create({
    provider: overrides?.provider ?? "fake",
    handle: { provider: overrides?.provider ?? "fake", remoteId: match[0]?.subject ?? subject, cursor: "0" },
    spec: {
      match,
      until: overrides?.until ?? { kind: "never" },
      target: {
        kind: "session",
        sessionId: overrides?.sessionId ?? "sess_1",
        urgency: overrides?.urgency ?? "next-turn",
      },
    },
  })
}

function resolverFor(provider: SentinelProviderHandle) {
  return async (slug: string): Promise<SentinelProviderHandle | null> =>
    slug === provider.slug ? provider : null
}

// ── Tests ────────────────────────────────────────────────────────────

describe("SentinelRuntime", () => {
  it("delivers a fake event as a system notice with the right urgency + correlationId", async () => {
    const store = createSentinelStore({ persist: false })
    const provider = createFakeSentinelProvider()
    const sentinel = newSentinel(store, { sessionId: "sess_1", urgency: "steer" })
    provider.emit(
      makeFakeEvent({ id: "evt_1", type: "fake.widget.created", subject: "fake:widget-1", summary: "Widget created" }),
    )

    const registry = stubRegistry(async () => okResult())
    const runtime = createSentinelRuntime({
      store,
      registry,
      resolveProvider: resolverFor(provider),
      isSessionAlive: () => true,
      restartSession: async id => id,
    })

    await runtime.pollOnce()

    expect(registry.calls).toHaveLength(1)
    const { msg, opts } = registry.calls[0]!
    expect(msg.to).toBe("sess_1")
    expect(msg.from).toEqual({ relation: "system" })
    expect(msg.kind).toBe("notice")
    expect(msg.urgency).toBe("steer")
    expect(msg.correlationId).toBe("sentinel:fake:widget-1")
    expect(msg.text).toBe("[fake] Widget created")
    expect(opts).toEqual({ source: "sentinel", origin: sentinel.id })

    const updated = store.get(sentinel.id)
    expect(updated?.eventCount).toBe(1)
    expect(updated?.lastEventTs).toBeDefined()
    expect(updated?.handle.cursor).toBe("1")
  })

  it("dedups: an event id already in the persisted `seen` window is never re-delivered", async () => {
    const store = createSentinelStore({ persist: false })
    const provider = createFakeSentinelProvider()
    const sentinel = newSentinel(store)
    const event = makeFakeEvent({ id: "evt_1", type: "fake.widget.created", subject: "fake:widget-1" })
    provider.emit(event)

    const registry = stubRegistry(async () => okResult())
    const runtime = createSentinelRuntime({
      store,
      registry,
      resolveProvider: resolverFor(provider),
      isSessionAlive: () => true,
      restartSession: async id => id,
    })

    await runtime.pollOnce()
    expect(registry.calls).toHaveLength(1)

    // Simulate a provider redelivery despite the daemon's own cursor having
    // advanced (e.g. an at-least-once provider replaying from an older ack
    // point after a crash) — reset the STORED cursor back to 0 so the fake
    // provider serves the same event again.
    const current = store.get(sentinel.id)!
    store.update(sentinel.id, { handle: { ...current.handle, cursor: "0" } })

    await runtime.pollOnce()
    // Still only ONE delivery — the persisted `seen` window caught the
    // redelivery even though the provider served it again.
    expect(registry.calls).toHaveLength(1)
  })

  it("a delivery that throws is NOT marked seen — the next tick redelivers it exactly once", async () => {
    const store = createSentinelStore({ persist: false })
    const provider = createFakeSentinelProvider()
    const sentinel = newSentinel(store)
    const event = makeFakeEvent({ id: "evt_1", type: "fake.widget.created", subject: "fake:widget-1" })
    provider.emit(event)

    let attempt = 0
    const registry = stubRegistry(async () => {
      attempt++
      if (attempt === 1) throw new Error("transient failure")
      return okResult()
    })
    const runtime = createSentinelRuntime({
      store,
      registry,
      resolveProvider: resolverFor(provider),
      isSessionAlive: () => true,
      restartSession: async id => id,
    })

    // First tick: sendMessage throws an unexpected error. The batch halts
    // without acking/advancing the cursor, and the event must NOT be marked
    // seen — otherwise the redelivery below would be silently swallowed by
    // dedup instead of landing.
    await runtime.pollOnce()
    expect(registry.calls).toHaveLength(1)
    expect(store.get(sentinel.id)?.eventCount).toBe(0)
    expect(store.isSeen(sentinel.id, "evt_1")).toBe(false)

    // Second tick: the provider still serves the same event (cursor never
    // advanced) — it must be redelivered, exactly once, not skipped.
    await runtime.pollOnce()
    expect(registry.calls).toHaveLength(2)
    expect(store.get(sentinel.id)?.eventCount).toBe(1)
    expect(store.isSeen(sentinel.id, "evt_1")).toBe(true)

    // A third tick has nothing new to redeliver — the event is now seen.
    await runtime.pollOnce()
    expect(registry.calls).toHaveLength(2)
  })

  it("dedup survives a store reload (daemon restart)", () => {
    const dir = mkdtempSync(join(tmpdir(), "sentinel-store-restart-"))
    const filePath = join(dir, "sentinels.json")
    try {
      const store1 = createSentinelStore({ filePath, persist: true, debounceMs: 0 })
      const sentinel = newSentinel(store1)
      expect(store1.markSeen(sentinel.id, "evt_1")).toBe(true)
      store1.flushSync()

      const store2 = createSentinelStore({ filePath, persist: true })
      expect(store2.get(sentinel.id)?.seen).toContain("evt_1")
      expect(store2.markSeen(sentinel.id, "evt_1")).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("until:count expires the sentinel and cancels the provider watch", async () => {
    const store = createSentinelStore({ persist: false })
    const provider = createFakeSentinelProvider()
    const sentinel = newSentinel(store, { until: { kind: "count", n: 2 } })
    provider.emit(makeFakeEvent({ id: "evt_1", type: "fake.a", subject: "fake:widget-1" }))
    provider.emit(makeFakeEvent({ id: "evt_2", type: "fake.b", subject: "fake:widget-1" }))

    const registry = stubRegistry(async () => okResult())
    const runtime = createSentinelRuntime({
      store,
      registry,
      resolveProvider: resolverFor(provider),
      isSessionAlive: () => true,
      restartSession: async id => id,
    })

    await runtime.pollOnce()

    expect(registry.calls).toHaveLength(2)
    expect(store.get(sentinel.id)?.status).toBe("expired")
    expect(provider.canceled.has("fake:widget-1")).toBe(true)

    // A third event arrives after expiry — the sentinel is no longer
    // pollable, so it's never even fetched.
    provider.emit(makeFakeEvent({ id: "evt_3", type: "fake.c", subject: "fake:widget-1" }))
    await runtime.pollOnce()
    expect(registry.calls).toHaveLength(2)
  })

  it("until:subject_terminal with multiple match clauses expires only once ALL clause subjects have seen a terminal event", async () => {
    const store = createSentinelStore({ persist: false })
    const provider = createFakeSentinelProvider()
    const sentinel = store.create({
      provider: provider.slug,
      handle: { provider: provider.slug, remoteId: "fake:widget-1", cursor: "0" },
      spec: {
        match: [{ subject: "fake:widget-1" }, { subject: "fake:widget-2" }],
        until: { kind: "subject_terminal" },
        target: { kind: "session", sessionId: "sess_1", urgency: "next-turn" },
      },
    })
    provider.emit(makeFakeEvent({ id: "evt_1", type: "fake.done", subject: "fake:widget-1", terminal: true }))

    const registry = stubRegistry(async () => okResult())
    const runtime = createSentinelRuntime({
      store,
      registry,
      resolveProvider: resolverFor(provider),
      isSessionAlive: () => true,
      restartSession: async id => id,
    })

    await runtime.pollOnce()
    // Only ONE of the two clause subjects has terminated so far — still
    // active, progress recorded on the record.
    expect(store.get(sentinel.id)?.status).toBe("active")
    expect(store.get(sentinel.id)?.terminalSubjects).toEqual(["fake:widget-1"])
    expect(provider.canceled.size).toBe(0)

    provider.emit(makeFakeEvent({ id: "evt_2", type: "fake.done", subject: "fake:widget-2", terminal: true }))
    await runtime.pollOnce()
    // Now BOTH clause subjects have terminated — expires and cancels.
    expect(store.get(sentinel.id)?.status).toBe("expired")
    expect([...(store.get(sentinel.id)?.terminalSubjects ?? [])].sort()).toEqual([
      "fake:widget-1",
      "fake:widget-2",
    ])
    expect(provider.canceled.has("fake:widget-1")).toBe(true)
    expect(registry.calls).toHaveLength(2)
  })

  it("re-attaches every pollable sentinel to its provider on start()", async () => {
    const store = createSentinelStore({ persist: false })
    const provider = createFakeSentinelProvider()
    // Simulate a sentinel restored from a prior daemon run.
    const restored = store.create({
      provider: provider.slug,
      handle: { provider: provider.slug, remoteId: "fake:widget-9", cursor: "5" },
      spec: {
        match: singleMatch("fake:widget-9"),
        until: { kind: "never" },
        target: { kind: "session", sessionId: "sess_9", urgency: "fyi" },
      },
    })

    const registry = stubRegistry(async () => okResult())
    const runtime = createSentinelRuntime({
      store,
      registry,
      resolveProvider: resolverFor(provider),
      isSessionAlive: () => true,
      restartSession: async id => id,
      activeIntervalMs: 15_000,
    })

    await runtime.start()
    try {
      expect(provider.attachCalls).toEqual([{ mode: "poll", intervalMs: 15_000 }])
      expect(store.get(restored.id)?.handle.remoteId).toBe("fake:widget-9")
    } finally {
      runtime.stop()
    }
  })

  it("marks an unknown provider slug as error on re-attach without throwing", async () => {
    const store = createSentinelStore({ persist: false })
    store.create({
      provider: "does-not-exist",
      handle: { provider: "does-not-exist", cursor: "0" },
      spec: {
        match: singleMatch("fake:widget-9"),
        until: { kind: "never" },
        target: { kind: "session", sessionId: "sess_9", urgency: "fyi" },
      },
    })
    const registry = stubRegistry(async () => okResult())
    const runtime = createSentinelRuntime({
      store,
      registry,
      resolveProvider: async () => null,
      isSessionAlive: () => true,
      restartSession: async id => id,
    })

    await runtime.start()
    runtime.stop()

    const sentinels = store.list()
    expect(sentinels).toHaveLength(1)
    expect(sentinels[0]!.status).toBe("error")
    expect(sentinels[0]!.lastError).toContain("does-not-exist")
  })

  it("parks the event and marks the sentinel orphaned when the target session is dead and unresumable", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sentinel-parked-"))
    const parkedPath = join(dir, "sentinels-parked.jsonl")
    try {
      const store = createSentinelStore({ persist: false })
      const provider = createFakeSentinelProvider()
      const sentinel = newSentinel(store, { sessionId: "sess_dead" })
      provider.emit(makeFakeEvent({ id: "evt_1", type: "fake.widget.created", subject: "fake:widget-1" }))

      const registry = stubRegistry(async msg => {
        throw new SessionNotAliveError(msg.to, "error", "sendMessage")
      })
      const runtime = createSentinelRuntime({
        store,
        registry,
        resolveProvider: resolverFor(provider),
        isSessionAlive: () => false,
        restartSession: async () => {
          throw new Error("cannot resume: adapter gone")
        },
        parkedPath,
      })

      await runtime.pollOnce()

      const updated = store.get(sentinel.id)
      expect(updated?.status).toBe("orphaned")
      // The batch still fully processed (parking isn't a hard failure) —
      // the cursor and event bookkeeping both advanced.
      expect(updated?.handle.cursor).toBe("1")
      expect(updated?.eventCount).toBe(1)

      const parked = readFileSync(parkedPath, "utf8").trim().split("\n").map(l => JSON.parse(l) as Record<string, unknown>)
      expect(parked).toHaveLength(1)
      expect(parked[0]!.sentinelId).toBe(sentinel.id)
      expect((parked[0]!.event as { id: string }).id).toBe("evt_1")
      expect(parked[0]!.reason).toContain("cannot resume")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("parks and orphans (no retry loop) when the target session row no longer exists", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sentinel-parked-"))
    const parkedPath = join(dir, "sentinels-parked.jsonl")
    try {
      const store = createSentinelStore({ persist: false })
      const provider = createFakeSentinelProvider()
      const sentinel = newSentinel(store, { sessionId: "sess_gone" })
      provider.emit(makeFakeEvent({ id: "evt_1", type: "fake.widget.created", subject: "fake:widget-1" }))

      const registry = stubRegistry(async msg => {
        throw new Error(`sendMessage: no session "${msg.to}"`)
      })
      const restartSession = vi.fn(async (): Promise<string> => {
        throw new Error("should not be called")
      })
      const runtime = createSentinelRuntime({
        store,
        registry,
        resolveProvider: resolverFor(provider),
        isSessionAlive: () => false,
        restartSession,
        sessionInfo: () => undefined,
        parkedPath,
      })

      await runtime.pollOnce()

      const updated = store.get(sentinel.id)
      expect(updated?.status).toBe("orphaned")
      expect(updated?.handle.cursor).toBe("1")
      expect(restartSession).not.toHaveBeenCalled()
      const parked = readFileSync(parkedPath, "utf8").trim().split("\n").map(l => JSON.parse(l) as Record<string, unknown>)
      expect(parked).toHaveLength(1)
      expect(parked[0]!.reason).toContain("no longer exists")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("resumes a dead session via restartSession and delivers to the resumed session id", async () => {
    const store = createSentinelStore({ persist: false })
    const provider = createFakeSentinelProvider()
    const sentinel = newSentinel(store, { sessionId: "sess_dead" })
    provider.emit(makeFakeEvent({ id: "evt_1", type: "fake.widget.created", subject: "fake:widget-1" }))

    const registry = stubRegistry(async msg => {
      if (msg.to === "sess_dead") {
        throw new SessionNotAliveError(msg.to, "error", "sendMessage")
      }
      return okResult()
    })
    const runtime = createSentinelRuntime({
      store,
      registry,
      resolveProvider: resolverFor(provider),
      isSessionAlive: () => false,
      restartSession: async () => "sess_resumed",
    })

    await runtime.pollOnce()

    expect(registry.calls).toHaveLength(2)
    expect(registry.calls[0]!.msg.to).toBe("sess_dead")
    expect(registry.calls[1]!.msg.to).toBe("sess_resumed")

    const updated = store.get(sentinel.id)
    expect(updated?.status).toBe("active")
    expect(updated?.spec.target).toEqual({ kind: "session", sessionId: "sess_resumed", urgency: "next-turn" })
  })

  it("in-place resume (restartSession returns the SAME id) → delivers to that id and does NOT re-target the sentinel", async () => {
    // PR C: the dead-session restart now revives the row IN PLACE, so the
    // sentinel's re-target must no-op — every following event keeps landing
    // on the same session instead of extending a continuedFrom chain.
    const store = createSentinelStore({ persist: false })
    const provider = createFakeSentinelProvider()
    const sentinel = newSentinel(store, { sessionId: "sess_dead" })
    provider.emit(makeFakeEvent({ id: "evt_1", type: "fake.widget.created", subject: "fake:widget-1" }))

    let attempts = 0
    const registry = stubRegistry(async msg => {
      // The first delivery hits the dead row; the post-restart redelivery to
      // the SAME id lands on the revived session and succeeds.
      if (msg.to === "sess_dead" && attempts++ === 0) {
        throw new SessionNotAliveError(msg.to, "error", "sendMessage")
      }
      return okResult()
    })
    const runtime = createSentinelRuntime({
      store,
      registry,
      resolveProvider: resolverFor(provider),
      isSessionAlive: () => false,
      restartSession: async id => id,
    })

    await runtime.pollOnce()

    expect(registry.calls).toHaveLength(2)
    expect(registry.calls[0]!.msg.to).toBe("sess_dead")
    // Delivered to the SAME id — no re-target, no new conversation.
    expect(registry.calls[1]!.msg.to).toBe("sess_dead")

    const updated = store.get(sentinel.id)
    expect(updated?.status).toBe("active")
    expect(updated?.spec.target).toEqual({ kind: "session", sessionId: "sess_dead", urgency: "next-turn" })
  })

  describe("closed subjects (merged/closed PR)", () => {
    const readParked = (path: string): Array<Record<string, unknown>> =>
      readFileSync(path, "utf8").trim().split("\n").map(l => JSON.parse(l) as Record<string, unknown>)

    it("parks post-merge non-terminal noise instead of waking or reviving the session", async () => {
      const dir = mkdtempSync(join(tmpdir(), "sentinel-closed-"))
      const parkedPath = join(dir, "sentinels-parked.jsonl")
      try {
        const store = createSentinelStore({ persist: false })
        const provider = createFakeSentinelProvider()
        const subject = "fake:pr-1558"
        const sentinel = newSentinel(store, { sessionId: "sess_dead", subject, match: singleMatch(subject, ["*"]) })
        provider.emit(makeFakeEvent({ id: "evt_merged", type: "fake.pull_request.closed", subject, terminal: true }))
        provider.emit(makeFakeEvent({ id: "evt_suite", type: "fake.check_suite.completed", subject }))

        let restarts = 0
        const registry = stubRegistry(async () => okResult())
        const runtime = createSentinelRuntime({
          store,
          registry,
          resolveProvider: resolverFor(provider),
          isSessionAlive: () => false,
          restartSession: async () => {
            restarts++
            return "sess_revived"
          },
          parkedPath,
        })

        await runtime.pollOnce()

        // Only the terminal (merge) notice was delivered; the check_suite
        // failure after the merge was parked and never woke anything.
        expect(registry.calls.map(c => (c.msg.data as { id: string }).id)).toEqual(["evt_merged"])
        expect(restarts).toBe(0)
        expect(store.get(sentinel.id)?.closedSubjects).toEqual([subject])
        const parked = readParked(parkedPath)
        expect(parked).toHaveLength(1)
        expect((parked[0]!.event as { id: string }).id).toBe("evt_suite")
        expect(parked[0]!.reason).toContain("already closed")
        // Marked seen so it is never reconsidered.
        expect(store.isSeen(sentinel.id, "evt_suite")).toBe(true)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })

    it("a reopen lifts the closed mark so later events deliver again", async () => {
      const dir = mkdtempSync(join(tmpdir(), "sentinel-closed-"))
      try {
        const store = createSentinelStore({ persist: false })
        const provider = createFakeSentinelProvider()
        const subject = "fake:pr-7"
        const sentinel = newSentinel(store, { subject, match: singleMatch(subject, ["*"]) })
        provider.emit(makeFakeEvent({ id: "e1", type: "fake.pull_request.closed", subject, terminal: true }))
        provider.emit(makeFakeEvent({ id: "e2", type: "fake.pull_request.reopened", subject }))
        provider.emit(makeFakeEvent({ id: "e3", type: "fake.check_suite.completed", subject }))

        const registry = stubRegistry(async () => okResult())
        const runtime = createSentinelRuntime({
          store,
          registry,
          resolveProvider: resolverFor(provider),
          isSessionAlive: () => true,
          restartSession: async id => id,
          parkedPath: join(dir, "parked.jsonl"),
        })
        await runtime.pollOnce()

        expect(registry.calls.map(c => (c.msg.data as { id: string }).id)).toEqual(["e1", "e2", "e3"])
        expect(store.get(sentinel.id)?.closedSubjects).toEqual([])
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })
  })

  describe("sessions closed with a deliberate outcome", () => {
    for (const endedReason of ["operator-completed", "steward-completed", "steward-abandoned", "operator-stopped"]) {
      it(`never resumes a session ended "${endedReason}" — notice goes to its live parent`, async () => {
        const store = createSentinelStore({ persist: false })
        const provider = createFakeSentinelProvider()
        newSentinel(store, { sessionId: "sess_done" })
        provider.emit(makeFakeEvent({ id: "evt_1", type: "fake.widget.created", subject: "fake:widget-1" }))

        let restarts = 0
        const registry = stubRegistry(async msg => {
          if (msg.to === "sess_done") throw new SessionNotAliveError(msg.to, "exited", "sendMessage")
          return okResult()
        })
        const runtime = createSentinelRuntime({
          store,
          registry,
          resolveProvider: resolverFor(provider),
          isSessionAlive: id => id === "sess_parent",
          restartSession: async () => {
            restarts++
            return "sess_revived"
          },
          sessionInfo: id => (id === "sess_done" ? { endedReason, parentSessionId: "sess_parent" } : undefined),
        })

        await runtime.pollOnce()

        expect(restarts).toBe(0)
        expect(registry.calls.map(c => c.msg.to)).toEqual(["sess_done", "sess_parent"])
        const forwarded = registry.calls[1]!.msg
        expect(forwarded.urgency).toBe("fyi")
        expect(forwarded.text).toContain("sess_done")
      })
    }

    it("with no live parent, parks the notice (inbox journal) and still does not resume", async () => {
      const dir = mkdtempSync(join(tmpdir(), "sentinel-closed-"))
      const parkedPath = join(dir, "sentinels-parked.jsonl")
      try {
        const store = createSentinelStore({ persist: false })
        const provider = createFakeSentinelProvider()
        const sentinel = newSentinel(store, { sessionId: "sess_done" })
        provider.emit(makeFakeEvent({ id: "evt_1", type: "fake.widget.created", subject: "fake:widget-1" }))

        let restarts = 0
        const registry = stubRegistry(async msg => {
          throw new SessionNotAliveError(msg.to, "exited", "sendMessage")
        })
        const runtime = createSentinelRuntime({
          store,
          registry,
          resolveProvider: resolverFor(provider),
          isSessionAlive: () => false,
          restartSession: async () => {
            restarts++
            return "sess_revived"
          },
          sessionInfo: () => ({ endedReason: "operator-completed" }),
          parkedPath,
        })

        await runtime.pollOnce()

        expect(restarts).toBe(0)
        expect(registry.calls).toHaveLength(1)
        expect(store.get(sentinel.id)?.status).toBe("orphaned")
        const parked = readFileSync(parkedPath, "utf8").trim().split("\n").map(l => JSON.parse(l) as Record<string, unknown>)
        expect(parked).toHaveLength(1)
        expect(parked[0]!.reason).toContain("operator-completed")
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })

    it("still resumes a session that died for a non-deliberate reason (crashed)", async () => {
      const store = createSentinelStore({ persist: false })
      const provider = createFakeSentinelProvider()
      newSentinel(store, { sessionId: "sess_crashed" })
      provider.emit(makeFakeEvent({ id: "evt_1", type: "fake.widget.created", subject: "fake:widget-1" }))
      const registry = stubRegistry(async msg => {
        if (msg.to === "sess_crashed") throw new SessionNotAliveError(msg.to, "error", "sendMessage")
        return okResult()
      })
      const runtime = createSentinelRuntime({
        store,
        registry,
        resolveProvider: resolverFor(provider),
        isSessionAlive: () => false,
        restartSession: async () => "sess_resumed",
        sessionInfo: () => ({ endedReason: "crashed" }),
      })
      await runtime.pollOnce()
      expect(registry.calls.map(c => c.msg.to)).toEqual(["sess_crashed", "sess_resumed"])
    })
  })
})
