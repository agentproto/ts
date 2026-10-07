/**
 * Tests for the `session` sentinel provider (AIP-60) — watching ANOTHER
 * session's own lifecycle instead of a GitHub subject.
 *
 * Provider-level unit tests exercise `sessionSentinelProvider` directly
 * against a fake `SessionEventBus` + session lookup (same style as
 * `sentinel-local-gh.test.ts`'s fake `GhRunner`). The end-to-end tests run
 * the real `createSentinelRuntime` poll loop on top, mirroring
 * `sentinel-runtime.test.ts`'s `createFakeSentinelProvider` style but with
 * genuine bus events standing in for the daemon's own `sessions.ts` emits.
 */

import { describe, expect, it } from "vitest"

import { createSessionEventBus, type SessionEventBus } from "../session-event-bus.js"
import {
  sessionSentinelProvider,
  parseSessionSubject,
  SESSION_SLUG,
  SESSION_DEFAULT_TYPES,
  type SessionSentinelLookup,
} from "../sentinel-providers/session.js"
import { singleMatch, type SentinelSpec } from "../sentinel-providers/types.js"
import { createSentinelStore, type SentinelStore } from "../sentinel-store.js"
import { createSentinelRuntime, type SentinelRuntimeRegistry } from "../sentinel-runtime.js"
import { createSentinelWatch, type SentinelWatchDeps } from "../sentinel-tools.js"
import type { SendMessageResult } from "../sessions.js"
import type { SessionMessage } from "../session-message.js"

// ── Fakes ────────────────────────────────────────────────────────────

function fakeLookup(sessions: Record<string, SessionSentinelLookup>) {
  return (sessionId: string): SessionSentinelLookup | undefined => sessions[sessionId]
}

function watchSpec(sessionId: string, target = "sess_target"): SentinelSpec {
  return {
    match: singleMatch(`session:${sessionId}`),
    until: { kind: "subject_terminal" },
    target: { kind: "session", sessionId: target, urgency: "next-turn" },
    provider: SESSION_SLUG,
  }
}

function bus_emitTurnEnd(bus: SessionEventBus, sessionId: string): void {
  bus.emit({ type: "session:turn-end", sessionId, awaitingInput: false, ts: new Date().toISOString() })
}

interface StubRegistry extends SentinelRuntimeRegistry {
  calls: Array<{ msg: SessionMessage; opts?: { source?: string; origin?: string } }>
}

function stubRegistry(): StubRegistry {
  const calls: StubRegistry["calls"] = []
  return {
    calls,
    async sendMessage(msg, opts) {
      calls.push({ msg, opts })
      return {
        messageId: "msg_test",
        delivered: { via: "turn" },
        queued: false,
        urgencyApplied: "next-turn",
      } satisfies SendMessageResult
    },
  }
}

// ── Provider unit tests ──────────────────────────────────────────────

describe("sessionSentinelProvider", () => {
  it("parses the session:<id> subject scheme", () => {
    expect(parseSessionSubject("session:sess_abc")).toBe("sess_abc")
    expect(parseSessionSubject("github:o/r#1")).toBeUndefined()
  })

  it("defaultTypes returns the three lifecycle types for a session subject, [] otherwise", () => {
    const provider = sessionSentinelProvider({
      sessionEvents: createSessionEventBus(),
      getSession: fakeLookup({}),
    })
    expect(provider.defaultTypes("session:sess_abc")).toEqual([...SESSION_DEFAULT_TYPES])
    expect(provider.defaultTypes("github:o/r#1")).toEqual([])
  })

  it("rejects create() for a non-session subject", async () => {
    const provider = sessionSentinelProvider({
      sessionEvents: createSessionEventBus(),
      getSession: fakeLookup({}),
    })
    await expect(
      provider.create(
        { match: singleMatch("github:o/r#1"), until: { kind: "never" }, target: { kind: "session", sessionId: "s1", urgency: "next-turn" } },
        { mode: "poll", intervalMs: 15_000 },
      ),
    ).rejects.toThrow(/not a "session:<id>" subject/)
  })

  it("rejects create() with more than one match clause", async () => {
    const provider = sessionSentinelProvider({
      sessionEvents: createSessionEventBus(),
      getSession: fakeLookup({ sess_a: { alive: true }, sess_b: { alive: true } }),
    })
    await expect(
      provider.create(
        {
          match: [{ subject: "session:sess_a" }, { subject: "session:sess_b" }],
          until: { kind: "never" },
          target: { kind: "session", sessionId: "s1", urgency: "next-turn" },
        },
        { mode: "poll", intervalMs: 15_000 },
      ),
    ).rejects.toThrow(/exactly one match clause/)
  })

  it("rejects create() for an unknown session id", async () => {
    const provider = sessionSentinelProvider({
      sessionEvents: createSessionEventBus(),
      getSession: fakeLookup({}),
    })
    await expect(
      provider.create(watchSpec("sess_ghost"), { mode: "poll", intervalMs: 15_000 }),
    ).rejects.toThrow(/no session "sess_ghost"/)
  })

  it("an already-exited target synthesizes an immediate terminal event on the first poll", async () => {
    const bus = createSessionEventBus()
    const provider = sessionSentinelProvider({
      sessionEvents: bus,
      getSession: fakeLookup({ sess_child: { alive: false, status: "exited", endedReason: "operator-completed" } }),
    })
    const handle = await provider.create(watchSpec("sess_child"), { mode: "poll", intervalMs: 15_000 })
    const result = await provider.poll!(handle, 50)
    expect(result.events).toHaveLength(1)
    expect(result.events[0]!.type).toBe("session.exited")
    expect(result.events[0]!.terminal).toBe(true)
    expect(result.events[0]!.subject).toBe("session:sess_child")
    expect(result.events[0]!.data.reason).toBe("operator-completed")
  })

  it("poll() only returns events after the cursor established at create() — no history replay", async () => {
    const bus = createSessionEventBus()
    bus.emit({ type: "session:turn-end", sessionId: "sess_child", awaitingInput: false, ts: "2026-01-01T00:00:00Z" })
    const provider = sessionSentinelProvider({ sessionEvents: bus, getSession: fakeLookup({ sess_child: { alive: true } }) })
    const handle = await provider.create(watchSpec("sess_child"), { mode: "poll", intervalMs: 15_000 })
    const result = await provider.poll!(handle, 50)
    expect(result.events).toEqual([])
  })

  it("filters strictly by the watched session's own subject", async () => {
    const bus = createSessionEventBus()
    const provider = sessionSentinelProvider({
      sessionEvents: bus,
      getSession: fakeLookup({ sess_a: { alive: true }, sess_b: { alive: true } }),
    })
    const handle = await provider.create(watchSpec("sess_a"), { mode: "poll", intervalMs: 15_000 })
    bus.emit({ type: "session:turn-end", sessionId: "sess_b", awaitingInput: false, ts: "2026-01-01T00:00:01Z" })
    bus.emit({ type: "session:turn-end", sessionId: "sess_a", awaitingInput: false, ts: "2026-01-01T00:00:02Z" })

    const result = await provider.poll!(handle, 50)
    expect(result.events).toHaveLength(1)
    expect(result.events[0]!.subject).toBe("session:sess_a")
  })

  it("a turn-end that leaves the session awaiting input and the paired awaiting-input event collapse to one id", async () => {
    const bus = createSessionEventBus()
    const provider = sessionSentinelProvider({ sessionEvents: bus, getSession: fakeLookup({ sess_child: { alive: true } }) })
    const handle = await provider.create(watchSpec("sess_child"), { mode: "poll", intervalMs: 15_000 })

    const ts = "2026-01-01T00:00:00Z"
    bus.emit({ type: "session:turn-end", sessionId: "sess_child", awaitingInput: true, ts, question: { text: "deploy now?", source: "heuristic" } })
    bus.emit({ type: "session:awaiting-input", sessionId: "sess_child", ts, question: { text: "deploy now?", source: "heuristic" } })

    const result = await provider.poll!(handle, 50)
    expect(result.events).toHaveLength(2)
    expect(result.events[0]!.id).toBe(result.events[1]!.id)
    expect(result.events[0]!.type).toBe("session.awaiting_input")
    expect(result.events[0]!.summary).toContain("deploy now?")
  })

  it("session:exited produces a terminal event carrying the exit reason", async () => {
    const bus = createSessionEventBus()
    const provider = sessionSentinelProvider({ sessionEvents: bus, getSession: fakeLookup({ sess_child: { alive: true } }) })
    const handle = await provider.create(watchSpec("sess_child"), { mode: "poll", intervalMs: 15_000 })

    bus.emit({ type: "session:exited", sessionId: "sess_child", status: "exited", reason: "steward-completed", ts: "2026-01-01T00:00:00Z" })

    const result = await provider.poll!(handle, 50)
    expect(result.events).toHaveLength(1)
    expect(result.events[0]!.type).toBe("session.exited")
    expect(result.events[0]!.terminal).toBe(true)
    expect(result.events[0]!.data.reason).toBe("steward-completed")
  })
})

// ── Daemon restart: the ring resets, the persisted cursor must not ───
// ── silently go deaf against it (epoch-tagged cursor) ────────────────

describe("sessionSentinelProvider across a simulated daemon restart", () => {
  it("attach() resyncs a stale (previous-process) cursor and subsequent events are still delivered", async () => {
    const busBeforeRestart = createSessionEventBus()
    const before = sessionSentinelProvider({ sessionEvents: busBeforeRestart, getSession: fakeLookup({ sess_child: { alive: true } }) })
    const persistedHandle = await before.create(watchSpec("sess_child"), { mode: "poll", intervalMs: 15_000 })

    // "Restart": a brand-new bus/ring (nextSeq back at 0, a fresh epoch) —
    // but `persistedHandle.cursor` still carries the OLD process's epoch,
    // exactly what `sentinel-store.ts` would have handed back after
    // reloading `sentinels.json`.
    const busAfterRestart = createSessionEventBus()
    const after = sessionSentinelProvider({ sessionEvents: busAfterRestart, getSession: fakeLookup({ sess_child: { alive: true } }) })
    const reattached = await after.attach(persistedHandle, { mode: "poll", intervalMs: 15_000 })
    expect(reattached.cursor).not.toBe(persistedHandle.cursor)

    bus_emitTurnEnd(busAfterRestart, "sess_child")
    const result = await after.poll!(reattached, 50)
    expect(result.events).toHaveLength(1)
    expect(result.events[0]!.type).toBe("session.turn.ended")
  })

  it("attach() treats a pre-epoch legacy bare-numeric cursor the same way — as stale", async () => {
    const bus = createSessionEventBus()
    const provider = sessionSentinelProvider({ sessionEvents: bus, getSession: fakeLookup({ sess_child: { alive: true } }) })
    const legacyHandle = { provider: SESSION_SLUG, remoteId: "sess_child", cursor: "1500", state: { sessionId: "sess_child" } }

    const reattached = await provider.attach(legacyHandle, { mode: "poll", intervalMs: 15_000 })
    bus_emitTurnEnd(bus, "sess_child")
    const result = await provider.poll!(reattached, 50)
    expect(result.events).toHaveLength(1)
  })

  it("attach() synthesizes a terminal event when the target exited WHILE the daemon was down", async () => {
    const busBeforeRestart = createSessionEventBus()
    const before = sessionSentinelProvider({ sessionEvents: busBeforeRestart, getSession: fakeLookup({ sess_child: { alive: true } }) })
    const persistedHandle = await before.create(watchSpec("sess_child"), { mode: "poll", intervalMs: 15_000 })

    // The real `session:exited` bus event never fired for this process —
    // it only fires live, and the exit happened during the downtime gap.
    const busAfterRestart = createSessionEventBus()
    const after = sessionSentinelProvider({
      sessionEvents: busAfterRestart,
      getSession: fakeLookup({ sess_child: { alive: false, status: "killed", endedReason: "idle-reaped" } }),
    })
    const reattached = await after.attach(persistedHandle, { mode: "poll", intervalMs: 15_000 })

    const result = await after.poll!(reattached, 50)
    expect(result.events).toHaveLength(1)
    expect(result.events[0]!.type).toBe("session.exited")
    expect(result.events[0]!.terminal).toBe(true)
    expect(result.events[0]!.data.reason).toBe("idle-reaped")
  })

  it("attach() synthesizes a 'gone' terminal event when the target no longer exists at all", async () => {
    const busBeforeRestart = createSessionEventBus()
    const before = sessionSentinelProvider({ sessionEvents: busBeforeRestart, getSession: fakeLookup({ sess_child: { alive: true } }) })
    const persistedHandle = await before.create(watchSpec("sess_child"), { mode: "poll", intervalMs: 15_000 })

    const busAfterRestart = createSessionEventBus()
    const after = sessionSentinelProvider({ sessionEvents: busAfterRestart, getSession: fakeLookup({}) })
    const reattached = await after.attach(persistedHandle, { mode: "poll", intervalMs: 15_000 })

    const result = await after.poll!(reattached, 50)
    expect(result.events).toHaveLength(1)
    expect(result.events[0]!.type).toBe("session.exited")
    expect(result.events[0]!.terminal).toBe(true)
  })

  it("poll() resyncs a stale cursor as a safety net even if attach() was skipped", async () => {
    const bus = createSessionEventBus()
    const provider = sessionSentinelProvider({ sessionEvents: bus, getSession: fakeLookup({ sess_child: { alive: true } }) })
    const staleHandle = { provider: SESSION_SLUG, remoteId: "sess_child", cursor: "some-other-epoch:999", state: { sessionId: "sess_child" } }

    // First poll with the stale cursor resyncs (no replay — same "start
    // from now" policy a fresh create()/attach() would apply) and returns
    // a freshly-epoched cursor.
    const first = await provider.poll!(staleHandle, 50)
    expect(first.events).toEqual([])
    expect(first.cursor).not.toBe(staleHandle.cursor)

    bus_emitTurnEnd(bus, "sess_child")
    const second = await provider.poll!({ ...staleHandle, cursor: first.cursor }, 50)
    expect(second.events).toHaveLength(1)
  })

  it("poll()'s safety net also synthesizes the terminal event for a target that exited during the gap", async () => {
    const bus = createSessionEventBus()
    const provider = sessionSentinelProvider({
      sessionEvents: bus,
      getSession: fakeLookup({ sess_child: { alive: false, status: "exited", endedReason: "operator-stopped" } }),
    })
    const staleHandle = { provider: SESSION_SLUG, remoteId: "sess_child", cursor: "some-other-epoch:42", state: { sessionId: "sess_child" } }

    const result = await provider.poll!(staleHandle, 50)
    expect(result.events).toHaveLength(1)
    expect(result.events[0]!.type).toBe("session.exited")
    expect(result.events[0]!.data.reason).toBe("operator-stopped")
  })
})

// ── End-to-end: the real poll loop + delivery pipeline ───────────────

describe("session sentinel through SentinelRuntime", () => {
  function setUp(bus: SessionEventBus, lookup: Record<string, SessionSentinelLookup>) {
    const store: SentinelStore = createSentinelStore({ persist: false })
    const provider = sessionSentinelProvider({ sessionEvents: bus, getSession: fakeLookup(lookup) })
    const registry = stubRegistry()
    const runtime = createSentinelRuntime({
      store,
      registry,
      resolveProvider: async slug => (slug === SESSION_SLUG ? provider : null),
      isSessionAlive: () => true,
      restartSession: async id => id,
    })
    return { store, provider, registry, runtime }
  }

  it("wakes the supervisor when the watched child ends a turn", async () => {
    const bus = createSessionEventBus()
    const { store, provider, runtime, registry } = setUp(bus, { sess_child: { alive: true, label: "child" } })
    const spec = watchSpec("sess_child", "sess_supervisor")
    const handle = await provider.create(spec, { mode: "poll", intervalMs: 15_000 })
    const sentinel = store.create({ provider: SESSION_SLUG, handle, spec })

    bus.emit({ type: "session:turn-end", sessionId: "sess_child", awaitingInput: false, label: "child", ts: new Date().toISOString() })
    await runtime.pollOnce()

    expect(registry.calls).toHaveLength(1)
    const { msg } = registry.calls[0]!
    expect(msg.to).toBe("sess_supervisor")
    expect(msg.correlationId).toBe("sentinel:session:sess_child")
    expect(msg.text).toContain("ended a turn")
    expect(store.get(sentinel.id)?.status).toBe("active")
  })

  it("expires the sentinel once the child exits (until: subject_terminal)", async () => {
    const bus = createSessionEventBus()
    const { store, provider, runtime, registry } = setUp(bus, { sess_child: { alive: true } })
    const spec = watchSpec("sess_child", "sess_supervisor")
    const handle = await provider.create(spec, { mode: "poll", intervalMs: 15_000 })
    const sentinel = store.create({ provider: SESSION_SLUG, handle, spec })

    bus.emit({ type: "session:exited", sessionId: "sess_child", status: "exited", reason: "operator-completed", ts: new Date().toISOString() })
    await runtime.pollOnce()

    expect(registry.calls).toHaveLength(1)
    expect(registry.calls[0]!.msg.text).toContain("exited")
    expect(store.get(sentinel.id)?.status).toBe("expired")
  })

  it("never delivers events from a different session than the one watched", async () => {
    const bus = createSessionEventBus()
    const { store, provider, runtime, registry } = setUp(bus, { sess_a: { alive: true }, sess_b: { alive: true } })
    const spec = watchSpec("sess_a", "sess_supervisor")
    const handle = await provider.create(spec, { mode: "poll", intervalMs: 15_000 })
    store.create({ provider: SESSION_SLUG, handle, spec })

    bus.emit({ type: "session:turn-end", sessionId: "sess_b", awaitingInput: false, ts: new Date().toISOString() })
    await runtime.pollOnce()

    expect(registry.calls).toHaveLength(0)
  })
})

// ── `sentinel_watch` wiring: defaults + provider auto-select ─────────

describe("createSentinelWatch for a session:<id> subject", () => {
  function deps(bus: SessionEventBus, lookup: Record<string, SessionSentinelLookup>): SentinelWatchDeps {
    const store = createSentinelStore({ persist: false })
    const provider = sessionSentinelProvider({ sessionEvents: bus, getSession: fakeLookup(lookup) })
    return {
      store,
      resolveProvider: async slug => (slug === SESSION_SLUG ? provider : null),
      isSessionAlive: () => true,
      defaultSessionId: "sess_caller",
    }
  }

  it("defaults provider to session and until to subject_terminal, with no explicit provider/until", async () => {
    const bus = createSessionEventBus()
    const result = await createSentinelWatch(deps(bus, { sess_child: { alive: true } }), { subject: "session:sess_child" })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("unreachable")
    expect(result.sentinel.provider).toBe(SESSION_SLUG)
    expect(result.sentinel.spec.until).toEqual({ kind: "subject_terminal" })
    expect(result.sentinel.spec.target).toEqual({ kind: "session", sessionId: "sess_caller", urgency: "next-turn" })
  })

  it("refuses an unknown watched session id with a clear message", async () => {
    const bus = createSessionEventBus()
    const result = await createSentinelWatch(deps(bus, {}), { subject: "session:sess_ghost" })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("unreachable")
    expect(result.message).toMatch(/no session "sess_ghost"/)
  })
})
