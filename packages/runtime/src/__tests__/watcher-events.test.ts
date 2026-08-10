/**
 * Watcher attach/detach bus events (E1) — `monitorSessionWait` emits
 * `session:watcher-attached` / `session:watcher-detached` alongside the
 * registry's ephemeral `watchers` counter, so a live UI inside the WATCHED
 * session can surface "a watcher attached/detached" (not just the
 * supervisor's own sidebar). Covers the long-poll branch only — the
 * ring-replay / already-in-target-state branches never subscribe, so they
 * never attach a watcher. Detection + signal only.
 */

import { describe, it, expect, vi } from "vitest"

import { monitorSessionWait } from "../orchestration-tools.js"
import { createSessionEventBus, type SessionEvent } from "../session-event-bus.js"
import { createEventRing } from "../event-ring.js"
import type { SessionsRegistry, SessionDescriptor } from "../sessions.js"

/**
 * A registry whose ONLY live behaviour is the watchers counter — the wait's
 * long-poll branch reads `registry.get(id)?.watchers` back after each
 * inc/dec to stamp the event's post-change count, so the stub has to
 * actually track it. Everything else is an inert vi.fn.
 */
function makeRegistry(descs: Record<string, SessionDescriptor>): SessionsRegistry {
  const watchers = new Map<string, number>()
  return {
    get: vi.fn((id: string) => {
      const desc = descs[id]
      if (!desc) return undefined
      // Stamp the live count at read time, mirroring the real registry.
      return { ...desc, watchers: watchers.get(id) ?? 0 }
    }),
    findByIdOrName: vi.fn((q: string) => descs[q]),
    incWatchers: vi.fn((id: string) => {
      watchers.set(id, (watchers.get(id) ?? 0) + 1)
    }),
    decWatchers: vi.fn((id: string) => {
      const next = (watchers.get(id) ?? 0) - 1
      if (next > 0) watchers.set(id, next)
      else watchers.delete(id)
    }),
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

/** A running, idle, never-finishing session — forces the bus long-poll branch. */
function idleSession(id: string): SessionDescriptor {
  return {
    id,
    kind: "agent-cli",
    workspaceSlug: "test",
    command: "mock",
    pid: null,
    status: "running",
    startedAt: new Date().toISOString(),
  }
}

/** Collect every bus event the wait emits, in order. */
function collectEvents(bus: ReturnType<typeof createSessionEventBus>): SessionEvent[] {
  const events: SessionEvent[] = []
  bus.onAny(ev => events.push(ev))
  return events
}

describe("watcher attach/detach bus events (monitorSessionWait)", () => {
  it("fires attached with the post-inc count, then detached on timeout back to 0", async () => {
    const registry = makeRegistry({ s1: idleSession("s1") })
    const bus = createSessionEventBus()
    const ring = createEventRing()
    const events = collectEvents(bus)

    const result = await monitorSessionWait({
      registry,
      sessionEvents: bus,
      eventRing: ring,
      sessionIds: ["s1"],
      event: "turn-end",
      timeoutMs: 20,
    })

    expect(result.timedOut).toBe(true)
    const attached = events.filter(e => e.type === "session:watcher-attached")
    const detached = events.filter(e => e.type === "session:watcher-detached")
    expect(attached).toHaveLength(1)
    expect(detached).toHaveLength(1)
    expect(attached[0]).toMatchObject({ sessionId: "s1", watchers: 1 })
    expect(detached[0]).toMatchObject({ sessionId: "s1", watchers: 0 })
    // No supervising session — an anonymous waiter carries no identity.
    expect((attached[0] as { watcherSessionId?: string }).watcherSessionId).toBeUndefined()
    expect((detached[0] as { watcherSessionId?: string }).watcherSessionId).toBeUndefined()
    // Registry counter balanced back to zero.
    expect(registry.get("s1")?.watchers).toBe(0)
  })

  it("fires detached on a bus match (not only on timeout)", async () => {
    const registry = makeRegistry({ s1: idleSession("s1") })
    const bus = createSessionEventBus()
    const ring = createEventRing()
    const events = collectEvents(bus)

    const pending = monitorSessionWait({
      registry,
      sessionEvents: bus,
      eventRing: ring,
      sessionIds: ["s1"],
      event: "turn-end",
      timeoutMs: 5_000,
    })
    // Let the wait subscribe + attach before the matching event lands.
    await new Promise(resolve => setTimeout(resolve, 10))
    bus.emit({ type: "session:turn-end", sessionId: "s1", awaitingInput: false, ts: new Date().toISOString() })
    const result = await pending

    expect(result.timedOut).toBeUndefined()
    expect(result.event).toBe("turn-end")
    const attached = events.filter(e => e.type === "session:watcher-attached")
    const detached = events.filter(e => e.type === "session:watcher-detached")
    expect(attached).toHaveLength(1)
    expect(detached).toHaveLength(1)
    expect(detached[0]).toMatchObject({ sessionId: "s1", watchers: 0 })
  })

  it("stamps watcherSessionId when the caller is a supervising session", async () => {
    const registry = makeRegistry({ s1: idleSession("s1") })
    const bus = createSessionEventBus()
    const ring = createEventRing()
    const events = collectEvents(bus)

    await monitorSessionWait({
      registry,
      sessionEvents: bus,
      eventRing: ring,
      sessionIds: ["s1"],
      event: "turn-end",
      timeoutMs: 20,
      callerScope: { ownerSessionId: "sess_supervisor" },
    })

    const attached = events.filter(e => e.type === "session:watcher-attached")
    const detached = events.filter(e => e.type === "session:watcher-detached")
    expect((attached[0] as { watcherSessionId?: string }).watcherSessionId).toBe("sess_supervisor")
    expect((detached[0] as { watcherSessionId?: string }).watcherSessionId).toBe("sess_supervisor")
  })

  it("emits one attach/detach pair per watched session id", async () => {
    const registry = makeRegistry({ s1: idleSession("s1"), s2: idleSession("s2") })
    const bus = createSessionEventBus()
    const ring = createEventRing()
    const events = collectEvents(bus)

    await monitorSessionWait({
      registry,
      sessionEvents: bus,
      eventRing: ring,
      sessionIds: ["s1", "s2"],
      event: "any",
      timeoutMs: 20,
    })

    const attached = events.filter(e => e.type === "session:watcher-attached")
    const detached = events.filter(e => e.type === "session:watcher-detached")
    expect(attached.map(e => (e as { sessionId: string }).sessionId).sort()).toEqual(["s1", "s2"])
    expect(detached.map(e => (e as { sessionId: string }).sessionId).sort()).toEqual(["s1", "s2"])
  })
})
