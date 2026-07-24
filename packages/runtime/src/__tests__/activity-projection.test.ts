/**
 * Unit tests for the PURE Activity mappers (activity-projection.ts): every
 * owner-state → the expected `{ state, waitingOn }` per the mechanical
 * active/pending discriminator, plus deterministic ids and the query
 * helpers. All inputs are fixture slices — no daemon, no bus.
 */

import { describe, expect, it } from "vitest"
import {
  activityCounts,
  filterActivities,
  isTerminalActivityState,
  linkTasks,
  policyToActivities,
  prToActivities,
  STALE_TURN_AFTER_MS,
  turnToActivities,
  workflowToActivities,
  type ActivityPolicySlice,
  type ActivityTaskSlice,
  type ActivityPrSession,
  type ActivityRecord,
  type ActivityRunStepSlice,
  type ActivityState,
  type ActivityTurnSession,
  type ActivityWaitingOn,
  type ActivityWorkflowRunSlice,
} from "../activity-projection.js"

const T0 = "2026-07-22T10:00:00.000Z"
const T1 = "2026-07-22T10:05:00.000Z"

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

function turnSession(over: Partial<ActivityTurnSession> = {}): ActivityTurnSession {
  return { id: "sess_a", kind: "agent-cli", status: "running", startedAt: T0, ...over }
}

function step(over: Partial<ActivityRunStepSlice> = {}): ActivityRunStepSlice {
  return { index: 0, label: "step", status: "pending", ...over }
}

const byId = (records: ActivityRecord[], id: string): ActivityRecord | undefined =>
  records.find(r => r.id === id)

describe("policyToActivities", () => {
  // The discriminator table, verbatim from the plan: gating/acting/nudging
  // → active (daemon-executed work); watching/queued/awaiting-ack → pending
  // with the right waitingOn.kind; done/blocked/cancelled → terminal.
  const table: Array<
    [ActivityPolicySlice["status"], ActivityState, ActivityWaitingOn["kind"] | undefined]
  > = [
    ["gating", "active", undefined],
    ["acting", "active", undefined],
    ["nudging", "active", undefined],
    ["watching", "pending", "session-turn"],
    ["queued", "pending", "cap-slot"],
    ["awaiting-ack", "pending", "human-ack"],
    ["done", "done", undefined],
    ["blocked", "failed", undefined],
    ["cancelled", "cancelled", undefined],
  ]
  for (const [status, state, waitingKind] of table) {
    it(`maps status "${status}" → ${state}${waitingKind ? ` (waitingOn ${waitingKind})` : ""}`, () => {
      const parent = byId(policyToActivities(policy({ status })), "policy:plc_1")
      expect(parent?.state).toBe(state)
      expect(parent?.waitingOn?.kind).toBe(waitingKind)
      // waitingOn is REQUIRED iff pending.
      expect(parent?.waitingOn !== undefined).toBe(state === "pending")
      expect(parent?.kind).toBe("policy")
      expect(parent?.source).toBe("supervisor")
      expect(parent?.sourceRef).toBe("plc_1")
    })
  }

  it("watching waits on the still-pending fan-in members, not the whole group", () => {
    const records = policyToActivities(
      policy({ sessionIds: ["sess_a", "sess_b", "sess_c"], pending: ["sess_b"] }),
    )
    const parent = byId(records, "policy:plc_1")
    expect(parent?.waitingOn?.refs).toEqual(["sess_b"])
    // A >1 group is surfaced on the record.
    expect(parent?.sessionIds).toEqual(["sess_a", "sess_b", "sess_c"])
  })

  it("watching with an emptied pending set falls back to the whole group", () => {
    const records = policyToActivities(policy({ pending: [] }))
    expect(byId(records, "policy:plc_1")?.waitingOn?.refs).toEqual(["sess_a"])
  })

  it("projects an active gate child while gating", () => {
    const records = policyToActivities(policy({ status: "gating" }))
    const gate = byId(records, "gate:plc_1")
    expect(gate?.state).toBe("active")
    expect(gate?.kind).toBe("gate")
    expect(gate?.parentActivityId).toBe("policy:plc_1")
  })

  it("settles the gate child from lastGate's exit code once not gating", () => {
    const green = byId(
      policyToActivities(policy({ status: "done", lastGate: { exitCode: 0, at: T1 } })),
      "gate:plc_1",
    )
    expect(green?.state).toBe("done")
    expect(green?.endedAt).toBe(T1)
    const red = byId(
      policyToActivities(policy({ status: "nudging", lastGate: { exitCode: 1, at: T1 } })),
      "gate:plc_1",
    )
    expect(red?.state).toBe("failed")
  })

  it("projects no gate child before any gate has run", () => {
    expect(byId(policyToActivities(policy()), "gate:plc_1")).toBeUndefined()
  })

  it("projects a pending human-ack commit child in awaiting-ack", () => {
    const records = policyToActivities(
      policy({ status: "awaiting-ack", commitPlan: { paths: ["a.ts"], message: "m" } }),
    )
    const commit = byId(records, "commit:plc_1")
    expect(commit?.state).toBe("pending")
    expect(commit?.waitingOn).toEqual({
      kind: "human-ack",
      refs: ["plc_1"],
      detail: "prepared commit awaiting policy_ack",
    })
    expect(commit?.parentActivityId).toBe("policy:plc_1")
  })

  it("commit child: acting → active, sha → done, cancelled/blocked → terminal", () => {
    const plan = { paths: ["a.ts"], message: "m" }
    expect(
      byId(policyToActivities(policy({ status: "acting", commitPlan: plan })), "commit:plc_1")
        ?.state,
    ).toBe("active")
    expect(
      byId(
        policyToActivities(policy({ status: "done", commitPlan: plan, commitSha: "abc" })),
        "commit:plc_1",
      )?.state,
    ).toBe("done")
    expect(
      byId(policyToActivities(policy({ status: "cancelled", commitPlan: plan })), "commit:plc_1")
        ?.state,
    ).toBe("cancelled")
    expect(
      byId(
        policyToActivities(policy({ status: "blocked", commitPlan: plan, error: "boom" })),
        "commit:plc_1",
      )?.state,
    ).toBe("failed")
  })

  it("is deterministic — same slice, identical records", () => {
    const slice = policy({ status: "gating", lastGate: { exitCode: 0, at: T1 } })
    expect(policyToActivities(slice)).toEqual(policyToActivities(slice))
  })
})

describe("turnToActivities", () => {
  it("projects nothing for non-agent-cli sessions", () => {
    expect(turnToActivities(turnSession({ kind: "terminal" }))).toEqual([])
    expect(turnToActivities(turnSession({ kind: "command" }))).toEqual([])
  })

  it("projects nothing for a fresh idle session (no turn ever ran)", () => {
    expect(turnToActivities(turnSession())).toEqual([])
  })

  it("busy → active on turn turnsCompleted+1", () => {
    const records = turnToActivities(turnSession({ busy: true, turnsCompleted: 2 }))
    expect(records).toHaveLength(1)
    expect(records[0]?.id).toBe("turn:sess_a:3")
    expect(records[0]?.state).toBe("active")
    expect(records[0]?.waitingOn).toBeUndefined()
    expect(records[0]?.source).toBe("session")
  })

  it("idle after a completed turn → done under the SAME id the busy turn had", () => {
    // While busy on the first turn (turnsCompleted 0) the id is turn:…:1 …
    const busy = turnToActivities(turnSession({ busy: true }))
    expect(busy[0]?.id).toBe("turn:sess_a:1")
    // … and once it completes (turnsCompleted 1, idle) the same id settles.
    const idle = turnToActivities(turnSession({ turnsCompleted: 1, lastActivityAt: T1 }))
    expect(idle[0]?.id).toBe("turn:sess_a:1")
    expect(idle[0]?.state).toBe("done")
    expect(idle[0]?.endedAt).toBe(T1)
  })

  it("awaiting-input → pending human-ack on the next turn", () => {
    const records = turnToActivities(
      turnSession({ awaitingInput: true, turnsCompleted: 1 }),
    )
    expect(records[0]?.id).toBe("turn:sess_a:2")
    expect(records[0]?.state).toBe("pending")
    expect(records[0]?.waitingOn?.kind).toBe("human-ack")
    expect(records[0]?.waitingOn?.refs).toEqual(["sess_a"])
  })

  it("a held permission parks the turn even while busy", () => {
    const records = turnToActivities(
      turnSession({ busy: true, awaitingPermission: true, turnsCompleted: 1 }),
    )
    expect(records[0]?.id).toBe("turn:sess_a:2")
    expect(records[0]?.state).toBe("pending")
    expect(records[0]?.waitingOn?.kind).toBe("human-ack")
  })

  it("killed mid-turn → cancelled; error mid-turn → failed", () => {
    const killed = turnToActivities(
      turnSession({ status: "killed", killedMidTurn: true, turnsCompleted: 1 }),
    )
    expect(killed[0]?.id).toBe("turn:sess_a:2")
    expect(killed[0]?.state).toBe("cancelled")
    const errored = turnToActivities(
      turnSession({ status: "error", killedMidTurn: true, turnsCompleted: 0 }),
    )
    expect(errored[0]?.id).toBe("turn:sess_a:1")
    expect(errored[0]?.state).toBe("failed")
  })

  it("clean exit settles the last completed turn; a 0-turn exit projects nothing", () => {
    const done = turnToActivities(turnSession({ status: "exited", turnsCompleted: 3 }))
    expect(done[0]?.id).toBe("turn:sess_a:3")
    expect(done[0]?.state).toBe("done")
    expect(turnToActivities(turnSession({ status: "exited" }))).toEqual([])
  })

  it("flags staleSince on an active turn silent past the threshold — state untouched", () => {
    const lastActivityAt = T0
    const staleNow = new Date(Date.parse(T0) + STALE_TURN_AFTER_MS + 1).toISOString()
    const freshNow = new Date(Date.parse(T0) + 1_000).toISOString()
    const stale = turnToActivities(turnSession({ busy: true, lastActivityAt }), { now: staleNow })
    expect(stale[0]?.state).toBe("active")
    expect(stale[0]?.staleSince).toBe(lastActivityAt)
    const fresh = turnToActivities(turnSession({ busy: true, lastActivityAt }), { now: freshNow })
    expect(fresh[0]?.staleSince).toBeUndefined()
  })
})

describe("workflowToActivities", () => {
  function wfRun(over: Partial<ActivityWorkflowRunSlice> = {}): ActivityWorkflowRunSlice {
    return { runId: "wf_1", status: "running", startedAt: T0, stages: [], ...over }
  }

  it("maps step statuses and derives the stage-barrier refs from earlier stages", () => {
    const records = workflowToActivities(
      wfRun({
        stages: [
          {
            index: 0,
            status: "running",
            steps: [
              step({ index: 0, status: "done", sessionId: "s00" }),
              step({ index: 1, status: "running", sessionId: "s01" }),
            ],
          },
          { index: 1, status: "pending", steps: [step({ index: 0, status: "pending" })] },
        ],
      }),
    )
    expect(byId(records, "workflow-step:wf_1:0:0")?.state).toBe("done")
    const active = byId(records, "workflow-step:wf_1:0:1")
    expect(active?.state).toBe("active")
    expect(active?.sourceRef).toBe("wf_1#0.1")
    expect(active?.source).toBe("workflow")
    const barred = byId(records, "workflow-step:wf_1:1:0")
    expect(barred?.state).toBe("pending")
    expect(barred?.waitingOn?.kind).toBe("stage-barrier")
    // Only stage 0's unfinished step holds the barrier.
    expect(barred?.waitingOn?.refs).toEqual(["s01"])
  })

  it("a step still pending inside a terminal run settles as cancelled", () => {
    const records = workflowToActivities(
      wfRun({
        status: "failed",
        stages: [{ index: 0, status: "skipped", steps: [step({ index: 0, status: "pending" })] }],
      }),
    )
    expect(byId(records, "workflow-step:wf_1:0:0")?.state).toBe("cancelled")
  })
})

describe("prToActivities", () => {
  const session: ActivityPrSession = {
    id: "sess_a",
    openedPrs: [
      { number: 412, url: "https://github.com/o/r/pull/412", openedAt: T0 },
      { number: 413, url: "https://github.com/o/r/pull/413", openedAt: T1 },
    ],
  }

  it("projects every opened PR as pending on the forge (v1 never settles)", () => {
    const records = prToActivities(session)
    expect(records.map(r => r.id)).toEqual(["pr:sess_a:412", "pr:sess_a:413"])
    for (const rec of records) {
      expect(rec.state).toBe("pending")
      expect(rec.waitingOn?.kind).toBe("forge")
      expect(rec.kind).toBe("pr")
      expect(rec.source).toBe("code-host")
    }
    expect(records[0]?.waitingOn?.refs).toEqual(["https://github.com/o/r/pull/412"])
    expect(records[0]?.sourceRef).toBe("https://github.com/o/r/pull/412")
    expect(records[0]?.startedAt).toBe(T0)
  })

  it("projects nothing for a session with no opened PRs", () => {
    expect(prToActivities({ id: "sess_b" })).toEqual([])
  })

  it("a resolved 'merged' state settles the record terminal done", () => {
    const records = prToActivities(session, {
      resolvedPrState: url => (url.endsWith("/412") ? "merged" : undefined),
    })
    const merged = byId(records, "pr:sess_a:412")
    expect(merged?.state).toBe("done")
    expect(merged?.waitingOn).toBeUndefined()
    expect(merged?.title).toContain("merged")
    // Deterministic id + sourceRef survive settlement — same record, new state.
    expect(merged?.sourceRef).toBe("https://github.com/o/r/pull/412")
    // The unresolved PR stays pending on the forge.
    expect(byId(records, "pr:sess_a:413")?.state).toBe("pending")
  })

  it("a resolved 'closed' state settles cancelled; 'open' stays pending", () => {
    const records = prToActivities(session, {
      resolvedPrState: url => (url.endsWith("/412") ? "closed" : "open"),
    })
    expect(byId(records, "pr:sess_a:412")?.state).toBe("cancelled")
    const open = byId(records, "pr:sess_a:413")
    expect(open?.state).toBe("pending")
    expect(open?.waitingOn?.kind).toBe("forge")
  })
})

describe("query helpers", () => {
  const records: ActivityRecord[] = [
    ...policyToActivities(policy()), // pending
    ...policyToActivities(policy({ policyId: "plc_2", status: "gating" })), // active ×2 (policy+gate)
    ...policyToActivities(policy({ policyId: "plc_3", status: "done" })), // done
    ...turnToActivities(turnSession({ id: "sess_b", busy: true })), // active
    ...prToActivities({
      id: "sess_b",
      openedPrs: [{ number: 1, url: "https://x/pull/1", openedAt: T0 }],
    }), // pending
  ]

  it("filterActivities excludes terminal records by default", () => {
    const out = filterActivities(records)
    expect(out.some(r => isTerminalActivityState(r.state))).toBe(false)
    expect(out.map(r => r.id)).toContain("policy:plc_1")
  })

  it("includeTerminal (or an explicit terminal state filter) restores them", () => {
    expect(filterActivities(records, { includeTerminal: true }).map(r => r.id)).toContain(
      "policy:plc_3",
    )
    expect(filterActivities(records, { state: "done" }).map(r => r.id)).toEqual(["policy:plc_3"])
  })

  it("filters by kind / source / state", () => {
    expect(filterActivities(records, { kind: "pr" }).map(r => r.id)).toEqual(["pr:sess_b:1"])
    expect(filterActivities(records, { source: "session" }).map(r => r.id)).toEqual([
      "turn:sess_b:1",
    ])
    expect(
      filterActivities(records, { state: "active" }).every(r => r.state === "active"),
    ).toBe(true)
  })

  it("sessionId matches the record's sessionId or any fan-in member", () => {
    const fanIn = policyToActivities(
      policy({ policyId: "plc_g", sessionIds: ["sess_x", "sess_y"], pending: ["sess_y"] }),
    )
    expect(filterActivities(fanIn, { sessionId: "sess_y" }).map(r => r.id)).toEqual([
      "policy:plc_g",
    ])
    expect(filterActivities(records, { sessionId: "sess_b" }).map(r => r.id)).toEqual([
      "turn:sess_b:1",
      "pr:sess_b:1",
    ])
  })

  it("activityCounts tallies active vs pending only", () => {
    expect(activityCounts(records)).toEqual({ active: 3, pending: 2 })
    expect(activityCounts([])).toEqual({ active: 0, pending: 0 })
  })
})

describe("linkTasks", () => {
  const task = (over: Partial<ActivityTaskSlice> = {}): ActivityTaskSlice => ({
    taskId: "task_1",
    status: "in_progress",
    ...over,
  })

  it("links a turn to the OPEN task its session owns", () => {
    const turns = turnToActivities(turnSession({ busy: true }), { now: T1 })
    const linked = linkTasks(turns, [task({ owner: "sess_a" })])
    expect(byId(linked, "turn:sess_a:1")?.taskId).toBe("task_1")
  })

  it("links a policy to the task whose verify gate is that policy", () => {
    const linked = linkTasks(policyToActivities(policy()), [
      task({ taskId: "task_9", status: "done", verification: { kind: "gate", policyId: "plc_1" } }),
    ])
    expect(byId(linked, "policy:plc_1")?.taskId).toBe("task_9")
  })

  it("does NOT link a turn to a CLOSED task (active work only)", () => {
    const turns = turnToActivities(turnSession({ busy: true }), { now: T1 })
    const linked = linkTasks(turns, [task({ status: "done", owner: "sess_a" })])
    expect(byId(linked, "turn:sess_a:1")?.taskId).toBeUndefined()
  })

  it("leaves records untouched when nothing links", () => {
    const turns = turnToActivities(turnSession({ busy: true }), { now: T1 })
    expect(linkTasks(turns, [])).toEqual(turns)
    expect(byId(linkTasks(turns, [task({ owner: "sess_other" })]), "turn:sess_a:1")?.taskId).toBeUndefined()
  })

  it("is deterministic — the first open task per session wins", () => {
    const turns = turnToActivities(turnSession({ busy: true }), { now: T1 })
    const linked = linkTasks(turns, [
      task({ taskId: "task_a", owner: "sess_a" }),
      task({ taskId: "task_b", owner: "sess_a" }),
    ])
    expect(byId(linked, "turn:sess_a:1")?.taskId).toBe("task_a")
  })
})
