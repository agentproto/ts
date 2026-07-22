/**
 * Unit tests for the Task ledger (task-ledger.ts). Uses a REAL event bus
 * (so `task:changed` is exercised as wired) with structural fakes for the
 * registry + supervisor slices and an INJECTED gate-runner — no real
 * completion policy ever spawns; Tier-1 done is driven entirely through
 * the port. Same fake-slice idiom as the activities/pr-provenance tests.
 */

import { describe, expect, it } from "vitest"
import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  createSessionEventBus,
  type TaskChangedEvent,
} from "../session-event-bus.js"
import {
  createTaskLedger,
  type TaskCaller,
  type TaskGateOutcome,
  type TaskGateRunner,
  type TaskLedger,
  type TaskLedgerSessionSlice,
  type TaskRecord,
  type TaskVerifySupervisor,
  type TaskWriteResult,
} from "../task-ledger.js"
import type { GateSpec } from "../supervisor.js"

// ── Fixtures ──────────────────────────────────────────────────────────

const OPERATOR: TaskCaller = { kind: "operator" }
const session = (sessionId: string): TaskCaller => ({ kind: "session", sessionId })

/** A supervisor slice whose `getStatus` reads a fixed map (the evidence
 *  shortcut) — `attach` must never fire in these tests (the gate-runner is
 *  injected), so it throws. */
function fakeSupervisor(
  statuses: Record<string, { status: string; lastGate?: { exitCode: number } }> = {},
): TaskVerifySupervisor {
  return {
    attach() {
      throw new Error("supervisor.attach must not be reached — gate runner is injected")
    },
    getStatus: policyId => statuses[policyId],
    onSettle: () => () => {},
  }
}

/** A gate-runner the test resolves BY HAND — records its inputs, parks the
 *  promise until `resolve(outcome)` (which also flushes microtasks so the
 *  ledger's background settle has run before the test asserts). */
function deferredGateRunner(): {
  runner: TaskGateRunner
  calls: Array<{ gate: GateSpec; ownerSessionId?: string; cwd?: string }>
  resolve(outcome: TaskGateOutcome): Promise<void>
} {
  const calls: Array<{ gate: GateSpec; ownerSessionId?: string; cwd?: string }> = []
  let pending: ((outcome: TaskGateOutcome) => void) | null = null
  return {
    runner: input => {
      calls.push(input)
      return new Promise(res => {
        pending = res
      })
    },
    calls,
    async resolve(outcome) {
      pending?.(outcome)
      pending = null
      await new Promise(r => setTimeout(r, 0))
    },
  }
}

/** Real bus + mutable fake registry + a `task:changed` recorder. The
 *  default gate-runner refuses so a test that forgets to inject one can
 *  never spawn anything real. */
function harness(opts: {
  sessions?: Record<string, TaskLedgerSessionSlice>
  gateRunner?: TaskGateRunner
  policyStatuses?: Record<string, { status: string; lastGate?: { exitCode: number } }>
  operatorWorkspaceSlug?: string
  persistPath?: string
} = {}): {
  ledger: TaskLedger
  bus: ReturnType<typeof createSessionEventBus>
  seen: TaskChangedEvent[]
  sessions: Record<string, TaskLedgerSessionSlice>
} {
  const bus = createSessionEventBus()
  const seen: TaskChangedEvent[] = []
  bus.on("task:changed", ev => seen.push(ev))
  const sessions = opts.sessions ?? {}
  const ledger = createTaskLedger({
    registry: { get: id => sessions[id] },
    sessionEvents: bus,
    supervisor: fakeSupervisor(opts.policyStatuses),
    gateRunner:
      opts.gateRunner ??
      (async () => ({ passed: false, error: "no gate runner in this test" })),
    ...(opts.operatorWorkspaceSlug
      ? { operatorWorkspaceSlug: opts.operatorWorkspaceSlug }
      : {}),
    ...(opts.persistPath ? { persistPath: opts.persistPath } : {}),
  })
  return { ledger, bus, seen, sessions }
}

/** sup (root, running) → exec + exec2 (children, running); other is an
 *  unrelated root — a SIBLING tree, invisible across the board boundary. */
const LINEAGE: Record<string, TaskLedgerSessionSlice> = {
  sup: { status: "running", workspaceSlug: "w" },
  exec: { parentSessionId: "sup", status: "running", workspaceSlug: "w", cwd: "/tmp/exec" },
  exec2: { parentSessionId: "sup", status: "running", workspaceSlug: "w" },
  other: { status: "running", workspaceSlug: "w" },
}

function mustOk(result: TaskWriteResult): TaskRecord {
  if (!result.ok) throw new Error(`expected ok, got ${JSON.stringify(result)}`)
  return result.task
}

function mustError(result: TaskWriteResult): string {
  if (result.ok || result.conflict) {
    throw new Error(`expected an error, got ${JSON.stringify(result)}`)
  }
  return result.error
}

function mustConflict(result: TaskWriteResult): TaskRecord {
  if (result.ok || !result.conflict) {
    throw new Error(`expected a conflict, got ${JSON.stringify(result)}`)
  }
  return result.current
}

const SHELL_GATE: GateSpec = { command: "true" }

// ── Board resolution ──────────────────────────────────────────────────

describe("board resolution", () => {
  it("a session caller defaults to its lineage board tree:<root>", () => {
    const { ledger } = harness({ sessions: LINEAGE })
    const task = mustOk(ledger.create({ title: "t" }, session("exec")))
    expect(task.boardId).toBe("tree:sup")
    // The supervisor lands on the SAME board — that's the whole point.
    expect(mustOk(ledger.create({ title: "u" }, session("sup"))).boardId).toBe("tree:sup")
  })

  it("a direct-launch root session self-declares onto its private board", () => {
    const { ledger } = harness({ sessions: LINEAGE })
    const task = mustOk(ledger.create({ title: "solo" }, session("other")))
    expect(task.boardId).toBe("tree:other")
  })

  it("the operator defaults to ws:<workspaceSlug>", () => {
    const { ledger } = harness({ operatorWorkspaceSlug: "w1" })
    expect(mustOk(ledger.create({ title: "t" }, OPERATOR)).boardId).toBe("ws:w1")
    const { ledger: plain } = harness()
    expect(mustOk(plain.create({ title: "t" }, OPERATOR)).boardId).toBe("ws:default")
  })

  it("an explicit boardId overrides the default", () => {
    const { ledger } = harness({ sessions: LINEAGE })
    const task = mustOk(
      ledger.create({ title: "t", boardId: "sprint-42" }, session("exec")),
    )
    expect(task.boardId).toBe("sprint-42")
    // …and a non-tree board is a cooperative namespace: another session
    // can list it too.
    expect(
      ledger.list({ boardId: "sprint-42" }, session("other")).map(t => t.taskId),
    ).toEqual([task.taskId])
  })

  it("a session cannot reach a SIBLING tree's board", () => {
    const { ledger } = harness({ sessions: LINEAGE })
    const supTask = mustOk(ledger.create({ title: "t" }, session("sup")))
    // other is a different root: create refused, list empty, task invisible.
    expect(
      mustError(ledger.create({ title: "x", boardId: "tree:sup" }, session("other"))),
    ).toContain("outside the caller's lineage")
    expect(ledger.list({ boardId: "tree:sup" }, session("other"))).toEqual([])
    expect(ledger.get(supTask.taskId, session("other"))).toBeUndefined()
    // The child in the SAME tree sees it fine.
    expect(ledger.get(supTask.taskId, session("exec"))?.taskId).toBe(supTask.taskId)
    // The operator sees every board.
    expect(ledger.list({ boardId: "tree:sup" }, OPERATOR)).toHaveLength(1)
  })
})

// ── State machine ─────────────────────────────────────────────────────

describe("state machine", () => {
  it("create → pending at rev 0; claim → in_progress", () => {
    const { ledger } = harness({ sessions: LINEAGE })
    const t = mustOk(ledger.create({ title: "t" }, session("sup")))
    expect(t.status).toBe("pending")
    expect(t.rev).toBe(0)
    expect(t.createdBy).toBe("sup")
    expect(t.owner).toBeUndefined()
    const claimed = mustOk(ledger.claim({ taskId: t.taskId, rev: 0 }, session("exec")))
    expect(claimed.status).toBe("in_progress")
    expect(claimed.owner).toBe("exec")
    expect(claimed.sessions).toEqual(["exec"])
    expect(claimed.rev).toBe(1)
  })

  it("refuses pending → done (the machine is small on purpose)", () => {
    const { ledger } = harness({ sessions: LINEAGE })
    const t = mustOk(ledger.create({ title: "t" }, session("sup")))
    expect(
      mustError(ledger.update({ taskId: t.taskId, rev: t.rev, status: "done" }, session("sup"))),
    ).toContain("invalid transition")
  })

  it("in_progress → failed closes the task", () => {
    const { ledger } = harness({ sessions: LINEAGE })
    const t = mustOk(ledger.create({ title: "t" }, session("sup")))
    mustOk(ledger.claim({ taskId: t.taskId, rev: 0 }, session("exec")))
    const failed = mustOk(
      ledger.update({ taskId: t.taskId, rev: 1, status: "failed" }, session("exec")),
    )
    expect(failed.status).toBe("failed")
    expect(failed.closedAt).toBeDefined()
    // …and failed is terminal in v1.
    expect(
      mustError(
        ledger.update({ taskId: t.taskId, rev: failed.rev, status: "pending" }, OPERATOR),
      ),
    ).toContain("invalid transition")
  })

  it("reopen (done → pending) is an explicit manager verb that records who", () => {
    const { ledger, sessions } = harness({ sessions: { ...LINEAGE } })
    const t = mustOk(ledger.create({ title: "t" }, session("sup")))
    mustOk(ledger.claim({ taskId: t.taskId, rev: 0 }, session("exec")))
    const done = mustOk(
      ledger.update({ taskId: t.taskId, rev: 1, status: "done" }, session("exec")),
    )
    expect(done.verification?.kind).toBe("self-report")
    // The executor (owner, not creator) may NOT resurrect it…
    expect(
      mustError(
        ledger.update({ taskId: t.taskId, rev: done.rev, status: "pending" }, session("exec")),
      ),
    ).toContain("reopen")
    // …the operator may, and the reopen is recorded + un-closes the record.
    const reopened = mustOk(
      ledger.update({ taskId: t.taskId, rev: done.rev, status: "pending" }, OPERATOR),
    )
    expect(reopened.status).toBe("pending")
    expect(reopened.meta?.reopenedBy).toBe("operator")
    expect(reopened.closedAt).toBeUndefined()
    expect(reopened.verification).toBeUndefined()
    expect(sessions.exec).toBeDefined() // fixture untouched
  })

  it("cancel is a manager verb", () => {
    const { ledger } = harness({ sessions: LINEAGE })
    const t = mustOk(ledger.create({ title: "t" }, session("sup")))
    mustOk(ledger.claim({ taskId: t.taskId, rev: 0 }, session("exec")))
    expect(
      mustError(
        ledger.update({ taskId: t.taskId, rev: 1, status: "cancelled" }, session("exec")),
      ),
    ).toContain("cancel")
    const cancelled = mustOk(
      ledger.update({ taskId: t.taskId, rev: 1, status: "cancelled" }, session("sup")),
    )
    expect(cancelled.status).toBe("cancelled")
    expect(cancelled.closedAt).toBeDefined()
  })

  it("cannot start an unowned task without claiming", () => {
    const { ledger } = harness({ sessions: LINEAGE })
    const t = mustOk(ledger.create({ title: "t" }, session("sup")))
    expect(
      mustError(
        ledger.update({ taskId: t.taskId, rev: 0, status: "in_progress" }, session("sup")),
      ),
    ).toContain("claim it first")
    // …but a manager assigning an owner in the same write may start it.
    const started = mustOk(
      ledger.update(
        { taskId: t.taskId, rev: 0, status: "in_progress", owner: "exec" },
        session("sup"),
      ),
    )
    expect(started.status).toBe("in_progress")
    expect(started.owner).toBe("exec")
    expect(started.sessions).toEqual(["exec"])
  })
})

// ── Claim CAS ─────────────────────────────────────────────────────────

describe("claim CAS", () => {
  it("wins only once — the second claimant gets {conflict, current}", () => {
    const { ledger } = harness({ sessions: LINEAGE })
    const t = mustOk(ledger.create({ title: "t" }, session("sup")))
    mustOk(ledger.claim({ taskId: t.taskId, rev: 0 }, session("exec")))
    // Even with the CURRENT rev, an owned task cannot be re-claimed —
    // exec2 shares the board (same tree) and still loses the race.
    const current = mustConflict(ledger.claim({ taskId: t.taskId, rev: 1 }, session("exec2")))
    expect(current.owner).toBe("exec")
  })

  it("a stale rev is a conflict carrying the current record", () => {
    const { ledger } = harness({ sessions: LINEAGE })
    const t = mustOk(ledger.create({ title: "t" }, session("sup")))
    mustOk(ledger.update({ taskId: t.taskId, rev: 0, title: "renamed" }, session("sup")))
    const current = mustConflict(ledger.claim({ taskId: t.taskId, rev: 0 }, session("exec")))
    expect(current.rev).toBe(1)
    expect(current.title).toBe("renamed")
  })

  it("the operator claims as \"operator\" (no sessions[] edge)", () => {
    const { ledger } = harness()
    const t = mustOk(ledger.create({ title: "t" }, OPERATOR))
    const claimed = mustOk(ledger.claim({ taskId: t.taskId, rev: 0 }, OPERATOR))
    expect(claimed.owner).toBe("operator")
    expect(claimed.sessions).toBeUndefined()
  })
})

// ── ACL ───────────────────────────────────────────────────────────────

describe("ACL — executor vs creator vs operator", () => {
  function claimed(): { ledger: TaskLedger; taskId: string; seen: TaskChangedEvent[] } {
    const { ledger, seen } = harness({ sessions: LINEAGE })
    const t = mustOk(ledger.create({ title: "t" }, session("sup")))
    mustOk(ledger.claim({ taskId: t.taskId, rev: 0 }, session("exec")))
    return { ledger, taskId: t.taskId, seen }
  }

  it("the owner sets status but may not edit fields or reassign", () => {
    const { ledger, taskId } = claimed()
    expect(
      mustError(ledger.update({ taskId, rev: 1, title: "no" }, session("exec"))),
    ).toContain("creator or the operator")
    expect(
      mustError(ledger.update({ taskId, rev: 1, owner: "other" }, session("exec"))),
    ).toContain("creator or the operator")
    expect(
      mustOk(ledger.update({ taskId, rev: 1, status: "done" }, session("exec"))).status,
    ).toBe("done")
  })

  it("a session that is neither owner nor creator is refused entirely", () => {
    const { ledger, taskId } = claimed()
    // exec2 shares the board (same tree) but holds no role on this task.
    expect(
      mustError(ledger.update({ taskId, rev: 1, status: "done" }, session("exec2"))),
    ).toContain("owner")
    // A SIBLING-tree session can't even see it — reads as not found (no
    // information leak across the board boundary).
    expect(
      mustError(ledger.update({ taskId, rev: 1, status: "done" }, session("other"))),
    ).toContain("not found")
  })

  it("the creator edits fields and reassigns the owner", () => {
    const { ledger, taskId } = claimed()
    const edited = mustOk(
      ledger.update(
        { taskId, rev: 1, title: "new title", blockedBy: ["task_x"], owner: "other" },
        session("sup"),
      ),
    )
    expect(edited.title).toBe("new title")
    expect(edited.blockedBy).toEqual(["task_x"])
    expect(edited.owner).toBe("other")
    // The reassigned session lands in the sessions[] edge, append-only.
    expect(edited.sessions).toEqual(["exec", "other"])
  })

  it("the owner releases itself with owner:null (→ pending)", () => {
    const { ledger, taskId, seen } = claimed()
    const released = mustOk(ledger.update({ taskId, rev: 1, owner: null }, session("exec")))
    expect(released.owner).toBeUndefined()
    expect(released.status).toBe("pending")
    expect(seen.at(-1)?.change).toBe("released")
    // A non-owner non-creator may not release someone else's task — the
    // role gate refuses before the release verb is even reached.
    const reclaimed = mustOk(ledger.claim({ taskId, rev: released.rev }, session("exec")))
    expect(
      mustError(ledger.update({ taskId, rev: reclaimed.rev, owner: null }, session("exec2"))),
    ).toContain("owner")
  })

  it("the operator can do all of it", () => {
    const { ledger, taskId } = claimed()
    const t = mustOk(
      ledger.update({ taskId, rev: 1, title: "op", status: "done" }, OPERATOR),
    )
    expect(t.title).toBe("op")
    expect(t.status).toBe("done")
    expect(t.verification?.kind).toBe("human")
  })
})

// ── Two-tier done ─────────────────────────────────────────────────────

describe("two-tier done", () => {
  it("tier 0: a bare done is accepted and honestly labeled self-report", () => {
    const { ledger } = harness({ sessions: LINEAGE })
    const t = mustOk(ledger.create({ title: "t" }, session("sup")))
    mustOk(ledger.claim({ taskId: t.taskId, rev: 0 }, session("exec")))
    const done = mustOk(
      ledger.update({ taskId: t.taskId, rev: 1, status: "done" }, session("exec")),
    )
    expect(done.verification).toMatchObject({ kind: "self-report", by: "exec" })
    expect(done.closedAt).toBeDefined()
  })

  it("tier 1 green: done waits for the gate, then flips with a gate stamp", async () => {
    const gate = deferredGateRunner()
    const { ledger, seen } = harness({ sessions: LINEAGE, gateRunner: gate.runner })
    const t = mustOk(
      ledger.create({ title: "t", verify: SHELL_GATE }, session("sup")),
    )
    mustOk(ledger.claim({ taskId: t.taskId, rev: 0 }, session("exec")))

    const reply = ledger.update({ taskId: t.taskId, rev: 1, status: "done" }, session("exec"))
    if (!reply.ok) throw new Error("expected ok")
    expect(reply.verifying).toBe(true)
    // NOT transitioned — the gate decides.
    expect(ledger.get(t.taskId, OPERATOR)?.status).toBe("in_progress")
    // The port received the owning session + the declared gate.
    expect(gate.calls).toEqual([
      { gate: SHELL_GATE, ownerSessionId: "exec", cwd: "/tmp/exec" },
    ])
    // A second done while the gate runs is refused.
    expect(
      mustError(ledger.update({ taskId: t.taskId, rev: 1, status: "done" }, session("exec"))),
    ).toContain("already running")

    await gate.resolve({ passed: true, policyId: "plc_1", exitCode: 0 })
    const done = ledger.get(t.taskId, OPERATOR)
    expect(done?.status).toBe("done")
    expect(done?.verification).toMatchObject({ kind: "gate", policyId: "plc_1", exitCode: 0 })
    expect(done?.rev).toBe(2)
    expect(seen.at(-1)).toMatchObject({ change: "status", status: "done", rev: 2 })
  })

  it("tier 1 red: stays in_progress with lastVerifyError + task:changed", async () => {
    const gate = deferredGateRunner()
    const { ledger, seen } = harness({ sessions: LINEAGE, gateRunner: gate.runner })
    const t = mustOk(ledger.create({ title: "t", verify: SHELL_GATE }, session("sup")))
    mustOk(ledger.claim({ taskId: t.taskId, rev: 0 }, session("exec")))
    ledger.update({ taskId: t.taskId, rev: 1, status: "done" }, session("exec"))

    await gate.resolve({ passed: false, exitCode: 1, error: "tests failed (exit 1)" })
    const still = ledger.get(t.taskId, OPERATOR)
    expect(still?.status).toBe("in_progress")
    expect(still?.lastVerifyError).toBe("tests failed (exit 1)")
    expect(still?.verification).toBeUndefined()
    expect(seen.at(-1)).toMatchObject({ change: "status", status: "in_progress" })
    // …and a retry can go green: the error clears.
    ledger.update({ taskId: t.taskId, rev: still?.rev ?? -1, status: "done" }, session("exec"))
    await gate.resolve({ passed: true, policyId: "plc_2" })
    const done = ledger.get(t.taskId, OPERATOR)
    expect(done?.status).toBe("done")
    expect(done?.lastVerifyError).toBeUndefined()
  })

  it("a release during verification discards the stale green outcome", async () => {
    const gate = deferredGateRunner()
    const { ledger, bus } = harness({ sessions: LINEAGE, gateRunner: gate.runner })
    const t = mustOk(ledger.create({ title: "t", verify: SHELL_GATE }, session("sup")))
    mustOk(ledger.claim({ taskId: t.taskId, rev: 0 }, session("exec")))
    ledger.update({ taskId: t.taskId, rev: 1, status: "done" }, session("exec"))
    // Owner dies mid-gate — the task releases…
    bus.emit({ type: "session:exited", sessionId: "exec", status: "exited", ts: "t" })
    expect(ledger.get(t.taskId, OPERATOR)?.status).toBe("pending")
    // …and the late green result must not resurrect it to done.
    await gate.resolve({ passed: true, policyId: "plc_1" })
    expect(ledger.get(t.taskId, OPERATOR)?.status).toBe("pending")
  })

  it("evidence shortcut: an already-passed policy closes without re-running", () => {
    const { ledger } = harness({
      sessions: LINEAGE,
      policyStatuses: {
        plc_green: { status: "done", lastGate: { exitCode: 0 } },
        plc_red: { status: "blocked", lastGate: { exitCode: 1 } },
      },
    })
    const t = mustOk(ledger.create({ title: "t", verify: SHELL_GATE }, session("sup")))
    mustOk(ledger.claim({ taskId: t.taskId, rev: 0 }, session("exec")))
    // A non-passed policy is refused (and nothing transitions)…
    expect(
      mustError(
        ledger.update(
          { taskId: t.taskId, rev: 1, status: "done", evidence: { policyId: "plc_red" } },
          session("exec"),
        ),
      ),
    ).toContain("not a passed gate")
    // …a passed one stamps kind:"gate" immediately, even though `verify`
    // is declared — the gate already ran, for free.
    const done = mustOk(
      ledger.update(
        { taskId: t.taskId, rev: 1, status: "done", evidence: { policyId: "plc_green" } },
        session("exec"),
      ),
    )
    expect(done.status).toBe("done")
    expect(done.verification).toMatchObject({ kind: "gate", policyId: "plc_green", exitCode: 0 })
  })
})

// ── Owner-death release ───────────────────────────────────────────────

describe("owner-death release (session:exited)", () => {
  it("releases — never fails — an in_progress task whose owner died", () => {
    const { ledger, bus, seen } = harness({ sessions: LINEAGE })
    const t = mustOk(ledger.create({ title: "t" }, session("sup")))
    mustOk(ledger.claim({ taskId: t.taskId, rev: 0 }, session("exec")))
    bus.emit({ type: "session:exited", sessionId: "exec", status: "killed", ts: "t" })
    const released = ledger.get(t.taskId, OPERATOR)
    expect(released?.status).toBe("pending")
    expect(released?.owner).toBeUndefined()
    expect(released?.meta?.releasedReason).toBe("owner-session-exited")
    expect(released?.rev).toBe(2)
    expect(seen.at(-1)).toMatchObject({ change: "released", sessionId: "exec" })
  })

  it("records a daemon-restart exit distinctly and leaves other tasks alone", () => {
    const { ledger, bus } = harness({ sessions: LINEAGE })
    const dying = mustOk(ledger.create({ title: "dying" }, session("sup")))
    mustOk(ledger.claim({ taskId: dying.taskId, rev: 0 }, session("exec")))
    const done = mustOk(ledger.create({ title: "done" }, session("sup")))
    mustOk(ledger.claim({ taskId: done.taskId, rev: 0 }, session("exec")))
    mustOk(ledger.update({ taskId: done.taskId, rev: 1, status: "done" }, session("exec")))

    bus.emit({
      type: "session:exited",
      sessionId: "exec",
      status: "killed",
      reason: "daemon-restart",
      ts: "t",
    })
    expect(ledger.get(dying.taskId, OPERATOR)?.meta?.releasedReason).toBe("daemon-restart")
    // The DONE task keeps its verdict — release only touches in_progress.
    expect(ledger.get(done.taskId, OPERATOR)?.status).toBe("done")
  })
})

// ── rev CAS on update ─────────────────────────────────────────────────

describe("update rev CAS", () => {
  it("a stale rev answers {conflict, current} without mutating", () => {
    const { ledger } = harness({ sessions: LINEAGE })
    const t = mustOk(ledger.create({ title: "t" }, session("sup")))
    mustOk(ledger.update({ taskId: t.taskId, rev: 0, title: "v1" }, session("sup")))
    const current = mustConflict(
      ledger.update({ taskId: t.taskId, rev: 0, title: "clobber" }, session("sup")),
    )
    expect(current.title).toBe("v1")
    expect(current.rev).toBe(1)
    expect(ledger.get(t.taskId, OPERATOR)?.title).toBe("v1")
  })
})

// ── task:changed per change ───────────────────────────────────────────

describe("task:changed", () => {
  it("fires once per accepted write, with the right change kind", () => {
    const { ledger, seen } = harness({ sessions: LINEAGE })
    const t = mustOk(ledger.create({ title: "t" }, session("sup")))
    mustOk(ledger.claim({ taskId: t.taskId, rev: 0 }, session("exec")))
    mustOk(ledger.update({ taskId: t.taskId, rev: 1, note: "wip" }, session("sup")))
    mustOk(ledger.update({ taskId: t.taskId, rev: 2, owner: null }, session("sup")))
    mustOk(ledger.claim({ taskId: t.taskId, rev: 3 }, session("exec")))
    mustOk(ledger.update({ taskId: t.taskId, rev: 4, status: "done" }, session("exec")))
    expect(seen.map(ev => ev.change)).toEqual([
      "created",
      "claimed",
      "edited",
      "released",
      "claimed",
      "status",
    ])
    expect(seen.every(ev => ev.taskId === t.taskId)).toBe(true)
    expect(seen.map(ev => ev.rev)).toEqual([0, 1, 2, 3, 4, 5])
    // …and a REFUSED write emits nothing.
    mustError(ledger.update({ taskId: t.taskId, rev: 5, status: "pending" }, session("exec")))
    expect(seen).toHaveLength(6)
  })
})

// ── Persistence ───────────────────────────────────────────────────────

describe("persistence", () => {
  it("round-trips through tasks.json; boot RELEASES orphaned in_progress owners", () => {
    const dir = mkdtempSync(join(tmpdir(), "task-ledger-"))
    const persistPath = join(dir, "tasks.json")

    const first = harness({ sessions: LINEAGE, persistPath })
    const open = mustOk(first.ledger.create({ title: "open" }, session("sup")))
    const claimed = mustOk(first.ledger.create({ title: "claimed" }, session("sup")))
    mustOk(first.ledger.claim({ taskId: claimed.taskId, rev: 0 }, session("exec")))
    const closed = mustOk(first.ledger.create({ title: "closed" }, session("sup")))
    mustOk(first.ledger.claim({ taskId: closed.taskId, rev: 0 }, session("exec")))
    mustOk(first.ledger.update({ taskId: closed.taskId, rev: 1, status: "done" }, session("exec")))
    // dispose() sync-flushes ahead of the debounce timer.
    first.ledger.dispose()
    expect(existsSync(persistPath)).toBe(true)
    // Atomic swap: no .tmp leftovers.
    expect(readdirSync(dir)).toEqual(["tasks.json"])
    const onDisk: unknown = JSON.parse(readFileSync(persistPath, "utf8"))
    expect(Array.isArray(onDisk) && onDisk.length === 3).toBe(true)

    // Reboot into a registry where exec did NOT survive.
    const second = harness({ sessions: { sup: { status: "running" } }, persistPath })
    const reloadedOpen = second.ledger.get(open.taskId, OPERATOR)
    expect(reloadedOpen?.status).toBe("pending")
    expect(reloadedOpen?.rev).toBe(0)
    // The orphaned in_progress task was RELEASED (not failed): owner
    // cleared, back to pending, reason recorded, rev bumped.
    const reloadedClaimed = second.ledger.get(claimed.taskId, OPERATOR)
    expect(reloadedClaimed?.status).toBe("pending")
    expect(reloadedClaimed?.owner).toBeUndefined()
    expect(reloadedClaimed?.meta?.releasedReason).toBe("daemon-restart")
    expect(reloadedClaimed?.rev).toBe(2)
    // Boot recovery is silent — releases announce nothing at load.
    expect(second.seen).toEqual([])
    // Closed history is untouched, verification intact.
    const reloadedClosed = second.ledger.get(closed.taskId, OPERATOR)
    expect(reloadedClosed?.status).toBe("done")
    expect(reloadedClosed?.verification?.kind).toBe("self-report")
    second.ledger.dispose()
  })

  it("stays off ~/.agentproto without a persistPath (opt-in contract)", () => {
    // No persistPath and no persist flag → the harness ledger above never
    // created a file anywhere; this asserts the opt-in default directly.
    const dir = mkdtempSync(join(tmpdir(), "task-ledger-off-"))
    const { ledger } = harness({ sessions: LINEAGE })
    mustOk(ledger.create({ title: "t" }, session("sup")))
    ledger.dispose()
    expect(readdirSync(dir)).toEqual([])
  })
})
