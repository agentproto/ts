/**
 * Regression coverage for two bugs in `monitorSessionWait`'s sync
 * already-in-target-state fast-path and its `empty`/`reason` propagation,
 * found while investigating a production incident where
 * `agentproto sessions wait "$sid" --until turn-end --timeout 40m` against a
 * persistent agent-cli session returned instantly and successfully instead
 * of blocking for a real turn-end.
 *
 * Both bugs are adapter-agnostic — they live entirely in this shared wait
 * primitive (`monitorSessionWait`), not in any ACP adapter. `opencode` and
 * `claude-code` both go through the exact same generic turn-end mechanism
 * (`connection.prompt()` resolving with a `stopReason` in
 * `packages/acp/src/client/index.ts`) — there is no adapter-specific gap.
 *
 * Bug 1 (stale fast-path): `turnsCompleted > 0` never resets, so the sync
 * fast-path matched ANY session that had ever completed a turn, regardless
 * of whether a NEW turn had started since this wait call began. A fresh,
 * separate `agentproto sessions wait` CLI process always starts with
 * `since=undefined` (no persisted cursor across invocations), so this path
 * decided the outcome on effectively every call for any reused/persistent
 * session — deterministic, not a rare race.
 *
 * Bug 2 (dropped empty/reason): `SessionTurnEndEvent.empty` / `.reason`
 * (already computed by `sessions.ts`'s `runAgentTurn`) were silently
 * dropped by all three of `monitorSessionWait`'s branches, so a caller
 * couldn't tell a real, productive turn-end from a silent no-op (bad
 * auth/model config) or an adapter-reported error.
 */

import { describe, it, expect, vi } from "vitest"

import { monitorSessionWait } from "../orchestration-tools.js"
import { createSessionEventBus } from "../session-event-bus.js"
import { createEventRing } from "../event-ring.js"
import type { SessionsRegistry, SessionDescriptor } from "../sessions.js"

function makeRegistry(descs: Record<string, SessionDescriptor>): SessionsRegistry {
  return {
    get: vi.fn((id: string) => descs[id]),
    findByIdOrName: vi.fn((q: string) => descs[q]),
    incWatchers: vi.fn(),
    decWatchers: vi.fn(),
    spawn: vi.fn(),
    register: vi.fn(),
    spawnAgent: vi.fn(),
    spawnPty: vi.fn(),
    sendPrompt: vi.fn(async () => {}),
    enqueuePrompt: vi.fn(),
    list: vi.fn(() => Object.values(descs)),
    attach: vi.fn(() => null),
    attachPty: vi.fn(() => null),
    writeTerminalInput: vi.fn(() => false),
    readTerminalOutput: vi.fn(async () => ({ lines: [], nextCursor: 0 })),
    tailLines: vi.fn(async () => ({ lines: [], nextCursor: 0, skipped: 0 })),
    kill: vi.fn(),
    forget: vi.fn(),
    shutdown: vi.fn(),
  } as unknown as SessionsRegistry
}

/** A session that finished ONE turn a while ago and is now sitting idle —
 *  the exact shape a reused/persistent agent-cli session has between
 *  prompts, and the shape that falsely satisfied the old fast-path. */
function idleAfterOneTurn(id: string, overrides: Partial<SessionDescriptor> = {}): SessionDescriptor {
  return {
    id,
    kind: "agent-cli",
    workspaceSlug: "test",
    command: "mock",
    pid: null,
    status: "running",
    startedAt: new Date().toISOString(),
    turnsCompleted: 1,
    busy: false,
    ...overrides,
  }
}

describe("monitorSessionWait — stale-turn fast-path (bug 1)", () => {
  it("a since-less wait does NOT instantly resolve against a stale prior turn — it actually waits for a new one", async () => {
    const registry = makeRegistry({ s1: idleAfterOneTurn("s1") })
    const bus = createSessionEventBus()
    const ring = createEventRing()

    const pending = monitorSessionWait({
      registry,
      sessionEvents: bus,
      eventRing: ring,
      sessionIds: ["s1"],
      event: "turn-end",
      timeoutMs: 5_000,
      // No `since` — exactly what a fresh, separate `agentproto sessions
      // wait` CLI process issues (no persisted cursor across invocations).
    })

    let settled = false
    void pending.then(() => {
      settled = true
    })
    // Give any synchronous/microtask resolution every chance to have
    // already fired. Pre-fix, this branch matched synchronously (well
    // before any timer), so `settled` would already be true here.
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(settled).toBe(false)

    // Only a genuinely NEW turn-end should resolve it.
    bus.emit({ type: "session:turn-end", sessionId: "s1", awaitingInput: false, ts: new Date().toISOString() })
    const result = await pending
    expect(result.source).toBe("bus")
    expect(result.event).toBe("turn-end")
  })

  it("WITH a `since` anchor, the fast-path still fires for the legitimate race (spawn-then-immediately-wait)", async () => {
    // The ONE scenario the fast-path exists for, per its own doc: a caller
    // captures a cursor before spawning, the turn finishes before the wait
    // subscribes to the bus, and the caller passes that cursor as `since`.
    const registry = makeRegistry({ s1: idleAfterOneTurn("s1") })
    const bus = createSessionEventBus()
    const ring = createEventRing()

    const result = await monitorSessionWait({
      registry,
      sessionEvents: bus,
      eventRing: ring,
      sessionIds: ["s1"],
      event: "turn-end",
      timeoutMs: 5_000,
      since: 0,
    })

    expect(result.source).toBe("state")
    expect(result.event).toBe("turn-end")
  })

  it("a since-less wait for a session that is BUSY (mid-turn) still correctly falls through to the bus, unaffected by the fix", async () => {
    const registry = makeRegistry({ s1: idleAfterOneTurn("s1", { busy: true }) })
    const bus = createSessionEventBus()
    const ring = createEventRing()

    const pending = monitorSessionWait({
      registry,
      sessionEvents: bus,
      eventRing: ring,
      sessionIds: ["s1"],
      event: "turn-end",
      timeoutMs: 5_000,
    })
    bus.emit({ type: "session:turn-end", sessionId: "s1", awaitingInput: false, ts: new Date().toISOString() })
    const result = await pending
    expect(result.source).toBe("bus")
  })
})

describe("monitorSessionWait — empty/reason propagation (bug 2)", () => {
  it("sync fast-path (source: state) surfaces `empty: true` from the persisted descriptor", async () => {
    const registry = makeRegistry({
      s1: idleAfterOneTurn("s1", { lastTurnEmpty: true }),
    })
    const bus = createSessionEventBus()
    const ring = createEventRing()

    const result = await monitorSessionWait({
      registry,
      sessionEvents: bus,
      eventRing: ring,
      sessionIds: ["s1"],
      event: "turn-end",
      timeoutMs: 5_000,
      since: 0,
    })

    expect(result.source).toBe("state")
    expect(result.empty).toBe(true)
  })

  it("sync fast-path (source: state) surfaces `reason: \"error\"` from the persisted descriptor", async () => {
    const registry = makeRegistry({
      s1: idleAfterOneTurn("s1", { lastTurnReason: "error" }),
    })
    const bus = createSessionEventBus()
    const ring = createEventRing()

    const result = await monitorSessionWait({
      registry,
      sessionEvents: bus,
      eventRing: ring,
      sessionIds: ["s1"],
      event: "turn-end",
      timeoutMs: 5_000,
      since: 0,
    })

    expect(result.source).toBe("state")
    expect(result.reason).toBe("error")
  })

  it("a productive turn (no lastTurnEmpty/lastTurnReason) leaves `empty`/`reason` absent, not false", async () => {
    const registry = makeRegistry({ s1: idleAfterOneTurn("s1") })
    const bus = createSessionEventBus()
    const ring = createEventRing()

    const result = await monitorSessionWait({
      registry,
      sessionEvents: bus,
      eventRing: ring,
      sessionIds: ["s1"],
      event: "turn-end",
      timeoutMs: 5_000,
      since: 0,
    })

    expect(result.empty).toBeUndefined()
    expect(result.reason).toBeUndefined()
  })

  it("ring-replay (source: ring) surfaces `empty: true` from the replayed event", async () => {
    const registry = makeRegistry({})
    const bus = createSessionEventBus()
    const ring = createEventRing()
    ring.wire(bus)

    bus.emit({
      type: "session:turn-end",
      sessionId: "s1",
      awaitingInput: false,
      ts: new Date().toISOString(),
      empty: true,
    })

    const result = await monitorSessionWait({
      registry,
      sessionEvents: bus,
      eventRing: ring,
      sessionIds: ["s1"],
      event: "turn-end",
      timeoutMs: 5_000,
      since: 0,
    })

    expect(result.source).toBe("ring")
    expect(result.empty).toBe(true)
  })

  it("ring-replay (source: ring) surfaces `reason: \"error\"` from the replayed event", async () => {
    const registry = makeRegistry({})
    const bus = createSessionEventBus()
    const ring = createEventRing()
    ring.wire(bus)

    bus.emit({
      type: "session:turn-end",
      sessionId: "s1",
      awaitingInput: false,
      ts: new Date().toISOString(),
      reason: "error",
    })

    const result = await monitorSessionWait({
      registry,
      sessionEvents: bus,
      eventRing: ring,
      sessionIds: ["s1"],
      event: "turn-end",
      timeoutMs: 5_000,
      since: 0,
    })

    expect(result.source).toBe("ring")
    expect(result.reason).toBe("error")
  })

  it("bus long-poll (source: bus) surfaces `empty: true` from the live event", async () => {
    const registry = makeRegistry({
      s1: { id: "s1", kind: "agent-cli", workspaceSlug: "test", command: "mock", pid: null, status: "running", startedAt: new Date().toISOString() },
    })
    const bus = createSessionEventBus()
    const ring = createEventRing()

    const pending = monitorSessionWait({
      registry,
      sessionEvents: bus,
      eventRing: ring,
      sessionIds: ["s1"],
      event: "turn-end",
      timeoutMs: 5_000,
    })
    await new Promise(resolve => setTimeout(resolve, 10))
    bus.emit({
      type: "session:turn-end",
      sessionId: "s1",
      awaitingInput: false,
      ts: new Date().toISOString(),
      empty: true,
    })
    const result = await pending

    expect(result.source).toBe("bus")
    expect(result.empty).toBe(true)
  })

  it("bus long-poll (source: bus) surfaces `reason: \"error\"` from the live event", async () => {
    const registry = makeRegistry({
      s1: { id: "s1", kind: "agent-cli", workspaceSlug: "test", command: "mock", pid: null, status: "running", startedAt: new Date().toISOString() },
    })
    const bus = createSessionEventBus()
    const ring = createEventRing()

    const pending = monitorSessionWait({
      registry,
      sessionEvents: bus,
      eventRing: ring,
      sessionIds: ["s1"],
      event: "turn-end",
      timeoutMs: 5_000,
    })
    await new Promise(resolve => setTimeout(resolve, 10))
    bus.emit({
      type: "session:turn-end",
      sessionId: "s1",
      awaitingInput: false,
      ts: new Date().toISOString(),
      reason: "error",
    })
    const result = await pending

    expect(result.source).toBe("bus")
    expect(result.reason).toBe("error")
  })
})
