/**
 * Unit tests for the Activity PROJECTOR (activities.ts). Uses a REAL event
 * bus (so `onAny`/`emit` are exercised as wired) with fake owner `list()`s
 * over mutable state — the same fake-registry idiom as the PR-provenance
 * reconciler tests. The bus handler runs synchronously, so emissions are
 * observable immediately after `bus.emit(...)`.
 */

import { describe, expect, it } from "vitest"
import {
  createSessionEventBus,
  type ActivityChangedEvent,
  type SessionEvent,
} from "../session-event-bus.js"
import {
  createActivityProjector,
  type ActivityProjectorSession,
} from "../activities.js"
import type { ActivityPolicySlice, ActivityTaskSlice } from "../activity-projection.js"

const T0 = "2026-07-22T10:00:00.000Z"

function policy(over: Partial<ActivityPolicySlice> = {}): ActivityPolicySlice {
  return {
    policyId: "plc_1",
    sessionId: "sess_a",
    sessionIds: ["sess_a"],
    pending: ["sess_a"],
    status: "watching",
    startedAt: T0,
    ...over,
  }
}

function agentSession(over: Partial<ActivityProjectorSession> = {}): ActivityProjectorSession {
  return { id: "sess_a", kind: "agent-cli", status: "running", startedAt: T0, ...over }
}

const turnEnd = (sessionId: string): SessionEvent => ({
  type: "session:turn-end",
  sessionId,
  awaitingInput: false,
  ts: T0,
})

const taskChanged = (taskId: string): SessionEvent => ({
  type: "task:changed",
  taskId,
  boardId: "tree:sess_a",
  change: "claimed",
  status: "in_progress",
  rev: 1,
  ts: T0,
})

/** Real bus + mutable fake owners + an `activity:changed` recorder. */
function harness(initial: {
  sessions?: ActivityProjectorSession[]
  policies?: ActivityPolicySlice[]
  tasks?: ActivityTaskSlice[]
} = {}) {
  const bus = createSessionEventBus()
  const state = {
    sessions: initial.sessions ?? [],
    policies: initial.policies ?? [],
    tasks: initial.tasks ?? [],
  }
  const seen: ActivityChangedEvent[] = []
  bus.on("activity:changed", ev => seen.push(ev))
  const projector = createActivityProjector({
    registry: { list: () => state.sessions },
    sessionEvents: bus,
    supervisor: { list: () => state.policies },
    taskLedger: { snapshot: () => state.tasks },
  })
  return { bus, state, seen, projector }
}

describe("createActivityProjector", () => {
  it("primes silently — pre-existing owner state emits nothing at construction", () => {
    const { seen } = harness({
      sessions: [agentSession({ busy: true })],
      policies: [policy()],
    })
    expect(seen).toEqual([])
  })

  it("emits activity:changed when an owner's state really moved", () => {
    const { bus, state, seen } = harness({ policies: [policy()] })
    // watching → queued flips the record pending(session-turn) → pending(cap-slot).
    state.policies = [policy({ status: "queued" })]
    bus.emit(turnEnd("sess_a"))
    expect(seen).toHaveLength(1)
    expect(seen[0]?.activity.id).toBe("policy:plc_1")
    expect(seen[0]?.activity.state).toBe("pending")
    expect(seen[0]?.activity.waitingOn?.kind).toBe("cap-slot")
  })

  it("does NOT re-emit when nothing changed (diff, not broadcast)", () => {
    const { bus, state, seen } = harness({ policies: [policy()] })
    state.policies = [policy({ status: "queued" })]
    bus.emit(turnEnd("sess_a"))
    expect(seen).toHaveLength(1)
    // Same owner state again — the re-projection diffs to nothing.
    bus.emit(turnEnd("sess_a"))
    bus.emit(turnEnd("sess_a"))
    expect(seen).toHaveLength(1)
  })

  it("announces a record appearing after construction (new id = a change)", () => {
    const { bus, state, seen } = harness()
    state.sessions = [agentSession({ busy: true })]
    bus.emit(turnEnd("sess_a"))
    expect(seen.map(ev => ev.activity.id)).toEqual(["turn:sess_a:1"])
    expect(seen[0]?.activity.state).toBe("active")
  })

  it("a policy:* event re-projects the supervisor owner only", () => {
    const { bus, state, seen } = harness({ policies: [policy()] })
    // Both owners moved, but a policy event only touches the supervisor
    // projection — the session change waits for the next session:* event.
    state.policies = [policy({ status: "done", endedAt: T0 })]
    state.sessions = [agentSession({ busy: true })]
    bus.emit({ type: "policy:passed", policyId: "plc_1", sessionId: "sess_a", ts: T0 })
    expect(seen.map(ev => ev.activity.id)).toEqual(["policy:plc_1"])
    expect(seen[0]?.activity.state).toBe("done")
    // The session's turn is announced once a session event arrives.
    bus.emit(turnEnd("sess_a"))
    expect(seen.map(ev => ev.activity.id)).toEqual(["policy:plc_1", "turn:sess_a:1"])
  })

  it("never re-enters off its own activity:changed emissions", () => {
    const { bus, state, seen } = harness()
    state.sessions = [agentSession({ busy: true })]
    // If the projector re-projected on activity:changed, the synchronous
    // emit inside the handler would recurse unboundedly — reaching a finite
    // count here IS the guard working.
    bus.emit(turnEnd("sess_a"))
    expect(seen).toHaveLength(1)
  })

  it("list() recomputes from the owners — never answered from the cache", () => {
    const { state, projector } = harness({ policies: [policy()] })
    // Owner state moves with NO bus event in between…
    state.policies = [policy({ status: "gating" })]
    // …and list() already sees it (policy active + its gate child).
    const out = projector.list()
    expect(out.map(r => r.id).sort()).toEqual(["gate:plc_1", "policy:plc_1"])
    expect(out.every(r => r.state === "active")).toBe(true)
  })

  it("list() does not consume the pending diff (cache is for diffing only)", () => {
    const { bus, state, seen, projector } = harness({ policies: [policy()] })
    state.policies = [policy({ status: "queued" })]
    // Reading the fresh state through list() must not swallow the
    // announcement the next event owes its subscribers.
    expect(projector.list()[0]?.waitingOn?.kind).toBe("cap-slot")
    bus.emit(turnEnd("sess_a"))
    expect(seen).toHaveLength(1)
    expect(seen[0]?.activity.waitingOn?.kind).toBe("cap-slot")
  })

  it("list() defaults to non-terminal and honours the filters", () => {
    const { state, projector } = harness({
      policies: [policy({ status: "done" }), policy({ policyId: "plc_2", status: "watching" })],
    })
    state.sessions = [agentSession({ busy: true })]
    expect(projector.list().map(r => r.id).sort()).toEqual(["policy:plc_2", "turn:sess_a:1"])
    expect(projector.list({ includeTerminal: true }).map(r => r.id)).toContain("policy:plc_1")
    expect(projector.list({ kind: "turn" }).map(r => r.id)).toEqual(["turn:sess_a:1"])
    expect(projector.list({ sessionId: "sess_a", source: "supervisor" }).map(r => r.id)).toEqual([
      "policy:plc_2",
    ])
  })

  it("dispose() detaches the bus subscription", () => {
    const { bus, state, seen, projector } = harness({ policies: [policy()] })
    projector.dispose()
    state.policies = [policy({ status: "done" })]
    bus.emit(turnEnd("sess_a"))
    expect(seen).toEqual([])
    // list() still recomputes — dispose only detaches the live diffing.
    expect(projector.list({ includeTerminal: true })[0]?.state).toBe("done")
  })

  it("is best-effort: a throwing owner list() neither escapes nor starves the others", () => {
    const bus = createSessionEventBus()
    const sessions: ActivityProjectorSession[] = []
    const seen: ActivityChangedEvent[] = []
    bus.on("activity:changed", ev => seen.push(ev))
    createActivityProjector({
      registry: { list: () => sessions },
      sessionEvents: bus,
      supervisor: {
        list: () => {
          throw new Error("supervisor exploded")
        },
      },
    })
    sessions.push(agentSession({ busy: true }))
    // The supervisor owner throws on every pass; the session owner must
    // still be re-projected and announced, and nothing may throw out of
    // the bus callback.
    expect(() => bus.emit(turnEnd("sess_a"))).not.toThrow()
    expect(seen.map(ev => ev.activity.id)).toEqual(["turn:sess_a:1"])
  })

  it("drops a vanished owner row from the diff cache without announcing", () => {
    const { bus, state, seen } = harness({ sessions: [agentSession({ busy: true })] })
    // The session disappears from the registry entirely (not a transition).
    state.sessions = []
    bus.emit(turnEnd("sess_a"))
    expect(seen).toEqual([])
    // …and if it comes back, its record is announced as new again.
    state.sessions = [agentSession({ busy: true })]
    bus.emit(turnEnd("sess_a"))
    expect(seen.map(ev => ev.activity.id)).toEqual(["turn:sess_a:1"])
  })

  it("joins Activity.taskId from the ledger at read time", () => {
    const { projector } = harness({
      sessions: [agentSession({ busy: true })],
      tasks: [{ taskId: "task_1", status: "in_progress", owner: "sess_a" }],
    })
    expect(projector.list().find(r => r.id === "turn:sess_a:1")?.taskId).toBe("task_1")
  })

  it("a task:changed re-projects and announces the new taskId link", () => {
    const { bus, state, seen } = harness({ sessions: [agentSession({ busy: true })] })
    // Primed: turn active, no task. A task now claims the session — the join
    // changes even though no owner *state* moved.
    state.tasks = [{ taskId: "task_1", status: "in_progress", owner: "sess_a" }]
    bus.emit(taskChanged("task_1"))
    expect(seen.map(ev => ev.activity.id)).toEqual(["turn:sess_a:1"])
    expect(seen[0]?.activity.taskId).toBe("task_1")
  })
})
