/**
 * Unit tests for SentinelRuntime (AIP-60 step 2).
 *
 * The runtime's `registry` dependency is structural (`{sendMessage}`), same
 * as `supervisor-notify.ts`'s `SupervisorNotifyRegistry` — these tests stub
 * it directly rather than standing up a full `SessionsRegistry`, since
 * nothing here depends on genuine descriptor/busy-flag shape (unlike
 * `supervisor-notify.test.ts`, which needs `markCrashed`).
 */

import { describe, expect, it } from "vitest"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createSentinelStore, type Sentinel, type SentinelStore } from "../sentinel-store.js"
import { createSentinelRuntime, type SentinelRuntimeRegistry } from "../sentinel-runtime.js"
import { createFakeSentinelProvider, makeFakeEvent } from "../sentinel-providers/fake.js"
import type { SentinelProviderHandle } from "../sentinel-providers/types.js"
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
    until?: Sentinel["spec"]["until"]
    provider?: string
  },
): Sentinel {
  const subject = overrides?.subject ?? "fake:widget-1"
  return store.create({
    provider: overrides?.provider ?? "fake",
    handle: { provider: overrides?.provider ?? "fake", remoteId: subject, cursor: "0" },
    spec: {
      subject,
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

  it("re-attaches every pollable sentinel to its provider on start()", async () => {
    const store = createSentinelStore({ persist: false })
    const provider = createFakeSentinelProvider()
    // Simulate a sentinel restored from a prior daemon run.
    const restored = store.create({
      provider: provider.slug,
      handle: { provider: provider.slug, remoteId: "fake:widget-9", cursor: "5" },
      spec: {
        subject: "fake:widget-9",
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
        subject: "fake:widget-9",
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
})
