/**
 * Activity ledger v1 — the PURE projection core.
 *
 * "Activity" is a unified read-model over the daemon's existing "what is
 * happening" silos: completion policies (supervisor), in-flight session
 * turns, workflow steps, and opened PRs. It is a **projection, not a
 * registry** — the owning subsystems keep their state machines untouched and
 * this module only MAPS their already-exposed state onto one shared record
 * shape. Nothing here is stored; re-running a mapper over the same owner
 * state yields byte-identical records (deterministic ids), which is what
 * makes re-projection idempotent and the ledger safely deletable.
 *
 * The active/pending discriminator is mechanical, never judged:
 *   - **active**  — the daemon is consuming compute for this activity NOW
 *     (a live child process, an in-flight LLM turn, a running gate command).
 *     The next transition is caused by work the daemon itself executes.
 *   - **pending** — nothing is executing; the activity holds only
 *     subscriptions. The next transition needs an EXTERNAL signal: another
 *     session's turn-end, a human `policy_ack`/`permissions_respond`, a
 *     forge result, a freed cap slot, a timer. `waitingOn` names that signal
 *     and is required exactly when `state === "pending"` (enforced by the
 *     {@link ActivityRecord} union).
 *
 * Pure by construction — no daemon imports, no I/O, no clock reads (callers
 * pass `now` where staleness is derived). Each mapper takes a STRUCTURAL
 * input slice (the `pr-provenance.ts` `FooterSession` pattern): the real
 * `PolicyRunState` / `SessionDescriptor` / `WorkflowRun` satisfy the slices
 * structurally, and tests fake them without casts. The
 * side-effecting projector (bus subscription, diffing, `activity:changed`
 * emission) lives in `activities.ts`.
 */

// ── Data model ───────────────────────────────────────────────────────

export const ACTIVITY_STATES = [
  "active",
  "pending",
  "done",
  "failed",
  "cancelled",
] as const
export type ActivityState = (typeof ACTIVITY_STATES)[number]

export const ACTIVITY_KINDS = [
  "turn",
  "policy",
  "gate",
  "commit",
  "workflow-step",
  "pr",
  "cron-run",
] as const
export type ActivityKind = (typeof ACTIVITY_KINDS)[number]

export const ACTIVITY_SOURCES = [
  "supervisor",
  "workflow",
  "session",
  "code-host",
  "cron",
] as const
export type ActivitySource = (typeof ACTIVITY_SOURCES)[number]

/**
 * What a `pending` activity is blocked on — the external signal whose
 * arrival causes the next transition. `refs` are the ids to poke: session
 * ids for `session-turn`, the policyId for `human-ack`/`cap-slot`, the PR
 * url for `forge`.
 */
export interface ActivityWaitingOn {
  kind: "session-turn" | "human-ack" | "cap-slot" | "stage-barrier" | "forge" | "timer"
  refs: string[]
  /** Optional human sentence naming the blocker. */
  detail?: string
}

/**
 * Everything an {@link ActivityRecord} carries besides its state. Split out
 * so the record union can enforce "waitingOn REQUIRED iff pending" at the
 * type level rather than by doc-comment.
 */
export interface ActivityRecordBase {
  /**
   * DETERMINISTIC, source-derived id — `policy:plc_x`, `turn:sess_y:3`,
   * `pr:sess_y:412` — NOT a uuid. Determinism is what makes re-projection
   * idempotent: the same owner state always maps to the same id, so the
   * projector's diff cache is disposable.
   */
  id: string
  kind: ActivityKind
  /** Subject session (fan-in policies additionally carry the group). */
  sessionId?: string
  sessionIds?: string[]
  /** Structural parent: a gate/commit activity points at its policy. */
  parentActivityId?: string
  /** FK into the owner: policyId, `runId#step`, PR url. */
  sourceRef: string
  source: ActivitySource
  /** One human sentence. */
  title: string
  startedAt: string
  endedAt?: string
  error?: string
  /**
   * Staleness FLAG (from the session's `lastActivityAt`), surfaced so a UI
   * can show "active but silent for 12min". Never auto-transitions the
   * state — an activity the owner says is active stays active.
   */
  staleSince?: string
  /**
   * The declared-intent Task this activity is advancing, when one links —
   * derived at read time by {@link linkTasks} from the Task ledger's edges
   * (a `turn`'s session owns a task; a `policy`'s id is a task's verify
   * gate). Absent when nothing links, and never a write path: Task stays the
   * source of truth for INTENT, Activity the projection for EXECUTION.
   */
  taskId?: string
}

/**
 * One activity. `active ⇄ pending` oscillates freely (honest for a policy's
 * watching→gating→nudging→watching→awaiting-ack life); `done`/`failed`/
 * `cancelled` are terminal. The union shape makes `waitingOn` REQUIRED on a
 * pending record and absent on every other state.
 */
export type ActivityRecord =
  | (ActivityRecordBase & { state: "pending"; waitingOn: ActivityWaitingOn })
  | (ActivityRecordBase & {
      state: Exclude<ActivityState, "pending">
      waitingOn?: undefined
    })

/** Terminal (immutable) activity states. */
export function isTerminalActivityState(state: ActivityState): boolean {
  return state === "done" || state === "failed" || state === "cancelled"
}

/**
 * Structural slice of a Task ledger row the join reads — the `TaskRecord`
 * satisfies it. Kept structural so this module stays free of a
 * `./task-ledger.js` import (and thus pure/standalone).
 */
export interface ActivityTaskSlice {
  taskId: string
  status: string
  /** The session currently on the task (absent = unclaimed). */
  owner?: string
  /** How done was reached; only a Tier-1 `gate` carries the `policyId` the
   *  join reads. `kind` is required so the full `TaskVerification` union (whose
   *  `self-report`/`human` variants have no `policyId`) still satisfies this. */
  verification?: { kind: string; policyId?: string }
}

/** A task is still open — an ACTIVE turn should only link to work in flight. */
function isOpenTaskStatus(status: string): boolean {
  return status !== "done" && status !== "failed" && status !== "cancelled"
}

/**
 * Enrich activities with the Task they advance — a read-time join, NOT a
 * write. Two edges the ledger owns: a `turn` activity links to the OPEN task
 * its session owns; a `policy` activity links to the task whose verify gate
 * is that policy. Everything else is left untouched (a gate/commit reads its
 * task through its parent policy in the UI). Deterministic and pure — the
 * same inputs always produce the same links.
 */
export function linkTasks(
  records: readonly ActivityRecord[],
  tasks: readonly ActivityTaskSlice[],
): ActivityRecord[] {
  const bySession = new Map<string, string>()
  const byPolicy = new Map<string, string>()
  for (const task of tasks) {
    if (task.owner && isOpenTaskStatus(task.status) && !bySession.has(task.owner)) {
      bySession.set(task.owner, task.taskId)
    }
    const policyId = task.verification?.policyId
    if (policyId && !byPolicy.has(policyId)) byPolicy.set(policyId, task.taskId)
  }
  return records.map(rec => {
    const taskId =
      rec.kind === "turn" && rec.sessionId
        ? bySession.get(rec.sessionId)
        : rec.kind === "policy"
          ? byPolicy.get(rec.sourceRef)
          : undefined
    return taskId ? { ...rec, taskId } : rec
  })
}

// Small constructors so every mapper builds records through the same two
// shapes — a pending record always gets its waitingOn, everything else
// never does.
function pendingRecord(base: ActivityRecordBase, waitingOn: ActivityWaitingOn): ActivityRecord {
  return { ...base, state: "pending", waitingOn }
}
function record(base: ActivityRecordBase, state: Exclude<ActivityState, "pending">): ActivityRecord {
  return { ...base, state }
}

// ── policy mapper (source: supervisor) ───────────────────────────────

/**
 * Structural slice of `supervisor.ts`'s `PolicyRunState` — the same rows
 * `policy_list` returns. The full state satisfies this.
 */
export interface ActivityPolicySlice {
  policyId: string
  /** Representative session id (fan-in group[0]). */
  sessionId: string
  /**
   * The full fan-in group being watched. OPTIONAL because supervisor state
   * persisted before fan-in (WP6) predates this field — legacy rows on disk
   * carry only `sessionId`, and the type must not lie about that.
   */
  sessionIds?: readonly string[]
  /**
   * Group members that have NOT yet finished their turn. OPTIONAL for the
   * same reason as `sessionIds`: pre-fan-in persisted supervisor state omits
   * it.
   */
  pending?: readonly string[]
  status:
    | "watching"
    | "queued"
    | "gating"
    | "acting"
    | "nudging"
    | "awaiting-ack"
    | "done"
    | "blocked"
    | "cancelled"
  startedAt: string
  endedAt?: string
  lastGate?: { exitCode: number; at: string }
  commitPlan?: { paths: readonly string[]; message: string }
  commitSha?: string
  error?: string
}

/**
 * Project one completion policy onto its `policy` activity, plus a child
 * `gate` activity once a gate has run (or is running) and a child `commit`
 * activity once a commit plan exists. Discriminator mapping (mechanical):
 * gating/acting/nudging → active (the daemon is running the gate / action /
 * nudge itself); watching → pending on the watched sessions' turns; queued →
 * pending on a freed cap slot; awaiting-ack → pending on a human
 * `policy_ack`. done → done, blocked → failed, cancelled → cancelled.
 */
export function policyToActivities(policy: ActivityPolicySlice): ActivityRecord[] {
  // Normalize the pre-fan-in (legacy) persisted shape ONCE: a legacy
  // single-session policy IS a one-member group (not an empty one — it is
  // still watching that session's turn), and nothing is outstanding yet.
  const sessionIds = policy.sessionIds ?? [policy.sessionId]
  const pending = policy.pending ?? []
  const parentId = `policy:${policy.policyId}`
  const base: ActivityRecordBase = {
    id: parentId,
    kind: "policy",
    sessionId: policy.sessionId,
    ...(sessionIds.length > 1 ? { sessionIds: [...sessionIds] } : {}),
    sourceRef: policy.policyId,
    source: "supervisor",
    title: `Completion policy ${policy.policyId} on ${
      sessionIds.length > 1 ? `${sessionIds.length} sessions` : policy.sessionId
    }`,
    startedAt: policy.startedAt,
    ...(policy.endedAt ? { endedAt: policy.endedAt } : {}),
    ...(policy.error ? { error: policy.error } : {}),
  }

  const records: ActivityRecord[] = []
  switch (policy.status) {
    case "gating":
    case "acting":
    case "nudging":
      records.push(record(base, "active"))
      break
    case "watching":
      records.push(
        pendingRecord(base, {
          kind: "session-turn",
          // The still-awaited members when the fan-in has partially landed;
          // the whole group otherwise.
          refs: pending.length > 0 ? [...pending] : [...sessionIds],
          detail: "waiting for the watched session(s) to finish their turn",
        }),
      )
      break
    case "queued":
      records.push(
        pendingRecord(base, {
          kind: "cap-slot",
          refs: [policy.policyId],
          detail: "queued behind the daemon-wide policy concurrency cap",
        }),
      )
      break
    case "awaiting-ack":
      records.push(
        pendingRecord(base, {
          kind: "human-ack",
          refs: [policy.policyId],
          detail: "green gate parked on policy_ack",
        }),
      )
      break
    case "done":
      records.push(record(base, "done"))
      break
    case "blocked":
      records.push(record(base, "failed"))
      break
    case "cancelled":
      records.push(record(base, "cancelled"))
      break
  }

  // Child `gate` activity — exists once a gate is running or has run. The
  // deterministic id means a re-gated policy (nudge retries) re-projects the
  // SAME record with the latest round's state, never a growing history.
  if (policy.status === "gating" || policy.lastGate) {
    const gateBase: ActivityRecordBase = {
      id: `gate:${policy.policyId}`,
      kind: "gate",
      sessionId: policy.sessionId,
      parentActivityId: parentId,
      sourceRef: policy.policyId,
      source: "supervisor",
      title: `Gate for policy ${policy.policyId}`,
      startedAt: policy.startedAt,
      ...(policy.status !== "gating" && policy.lastGate
        ? { endedAt: policy.lastGate.at }
        : {}),
    }
    if (policy.status === "gating") {
      records.push(record(gateBase, "active"))
    } else if (policy.lastGate) {
      records.push(record(gateBase, policy.lastGate.exitCode === 0 ? "done" : "failed"))
    }
  }

  // Child `commit` activity — exists once the supervisor has prepared a
  // commit plan (entering awaiting-ack, or just before a direct commit).
  if (policy.commitPlan || policy.commitSha) {
    const commitBase: ActivityRecordBase = {
      id: `commit:${policy.policyId}`,
      kind: "commit",
      sessionId: policy.sessionId,
      parentActivityId: parentId,
      sourceRef: policy.policyId,
      source: "supervisor",
      title: `Commit for policy ${policy.policyId}`,
      startedAt: policy.startedAt,
      ...(policy.endedAt ? { endedAt: policy.endedAt } : {}),
      ...(policy.error ? { error: policy.error } : {}),
    }
    if (policy.commitSha) {
      records.push(record(commitBase, "done"))
    } else if (policy.status === "acting") {
      records.push(record(commitBase, "active"))
    } else if (policy.status === "cancelled") {
      records.push(record(commitBase, "cancelled"))
    } else if (policy.status === "blocked") {
      records.push(record(commitBase, "failed"))
    } else {
      // awaiting-ack (and, defensively, any other non-terminal status a
      // commitPlan can coexist with): the commit waits on a human ack.
      records.push(
        pendingRecord(commitBase, {
          kind: "human-ack",
          refs: [policy.policyId],
          detail: "prepared commit awaiting policy_ack",
        }),
      )
    }
  }

  return records
}

// ── turn mapper (source: session) ────────────────────────────────────

/**
 * An active `turn` activity whose session has been silent (no adapter
 * traffic, `lastActivityAt`) for longer than this gets a `staleSince` flag.
 * A flag only — the state stays whatever the owner says it is.
 */
export const STALE_TURN_AFTER_MS = 10 * 60_000

/**
 * Structural slice of `SessionDescriptor` the turn mapper reads. The full
 * descriptor satisfies this (see `FooterSession` for the pattern).
 */
export interface ActivityTurnSession {
  id: string
  kind?: string
  status?: string
  startedAt: string
  busy?: boolean
  awaitingInput?: boolean
  awaitingPermission?: boolean
  turnsCompleted?: number
  killedMidTurn?: boolean
  lastActivityAt?: string
}

/**
 * Project a session's CURRENT turn (never its history) onto at most one
 * `turn` activity. Turn ordinals are 1-based off `turnsCompleted`, so the
 * same conversational beat keeps one id across its whole life: turn n is
 * `turn:<sid>:<n>` while busy (`turnsCompleted` is still n-1), and the id
 * stays `turn:<sid>:<n>` once it completes (`turnsCompleted` becomes n) —
 * the record transitions active → done in place. Discriminator: busy →
 * active; awaiting-input / a held permission → pending `human-ack`; a
 * terminal session settles the in-flight turn (killedMidTurn → cancelled /
 * failed) or the last completed one (→ done). An idle session that never
 * ran a turn projects nothing.
 */
export function turnToActivities(
  session: ActivityTurnSession,
  opts: { now?: string } = {},
): ActivityRecord[] {
  // Only agent-cli sessions run turns; a terminal/command session never does.
  if (session.kind !== "agent-cli") return []

  const completed = session.turnsCompleted ?? 0
  const base = (turn: number, title: string): ActivityRecordBase => ({
    id: `turn:${session.id}:${turn}`,
    kind: "turn",
    sessionId: session.id,
    sourceRef: session.id,
    source: "session",
    title,
    startedAt: session.startedAt,
  })

  const terminal =
    session.status === "exited" || session.status === "killed" || session.status === "error"
  if (terminal) {
    if (session.killedMidTurn === true) {
      // The in-flight turn (n = completed+1) died with the session.
      const rec = record(
        base(completed + 1, `Turn ${completed + 1} interrupted on ${session.id}`),
        session.status === "error" ? "failed" : "cancelled",
      )
      return [{ ...rec, ...(session.lastActivityAt ? { endedAt: session.lastActivityAt } : {}) }]
    }
    if (completed > 0) {
      const rec = record(base(completed, `Turn ${completed} completed on ${session.id}`), "done")
      return [{ ...rec, ...(session.lastActivityAt ? { endedAt: session.lastActivityAt } : {}) }]
    }
    return []
  }

  // A held permission parks the turn regardless of `busy` — nothing is
  // executing until a human/orchestrator answers `permissions_respond`.
  if (session.awaitingPermission === true) {
    return [
      pendingRecord(base(completed + 1, `Turn ${completed + 1} on ${session.id} held on a permission`), {
        kind: "human-ack",
        refs: [session.id],
        detail: "permission request parked for permissions_respond",
      }),
    ]
  }

  if (session.busy === true) {
    const rec = record(base(completed + 1, `Turn ${completed + 1} running on ${session.id}`), "active")
    // Staleness flag: active but silent for longer than the threshold.
    if (opts.now && session.lastActivityAt) {
      const nowMs = Date.parse(opts.now)
      const lastMs = Date.parse(session.lastActivityAt)
      if (Number.isFinite(nowMs) && Number.isFinite(lastMs) && nowMs - lastMs > STALE_TURN_AFTER_MS) {
        return [{ ...rec, staleSince: session.lastActivityAt }]
      }
    }
    return [rec]
  }

  if (session.awaitingInput === true) {
    // The previous turn ended awaiting-input (and bumped turnsCompleted);
    // the NEXT turn is what's pending on the human's reply.
    return [
      pendingRecord(base(completed + 1, `Awaiting human input on ${session.id}`), {
        kind: "human-ack",
        refs: [session.id],
        detail: "session asked a question; next turn needs a human prompt",
      }),
    ]
  }

  // Idle after at least one completed turn: the last turn, settled.
  if (completed > 0) {
    const rec = record(base(completed, `Turn ${completed} completed on ${session.id}`), "done")
    return [{ ...rec, ...(session.lastActivityAt ? { endedAt: session.lastActivityAt } : {}) }]
  }

  // Freshly spawned, never ran a turn — nothing to project.
  return []
}

// ── workflow-step mapper (source: workflow) ──────────────────────────

/** Structural slice of a run's step state — shared by `workflow-runner.ts`'s
 *  `WorkflowStageState.steps`. */
export interface ActivityRunStepSlice {
  index: number
  label: string
  status: "pending" | "running" | "done" | "failed" | "skipped"
  sessionId?: string
  startedAt?: string
  endedAt?: string
  error?: string
}

/** Structural slice of `workflow-runner.ts`'s `WorkflowStageState`. */
export interface ActivityWorkflowStageSlice {
  index: number
  label?: string
  status: "pending" | "running" | "done" | "failed" | "skipped"
  steps: readonly ActivityRunStepSlice[]
}

/** Structural slice of a `WorkflowRun` (`workflow_list` rows). */
export interface ActivityWorkflowRunSlice {
  runId: string
  status: string
  startedAt: string
  endedAt?: string
  stages: readonly ActivityWorkflowStageSlice[]
}

/**
 * Project one workflow run's steps (stage-barrier semantics): running →
 * active; a `pending` step waits on the stage barrier — the unfinished
 * steps of EARLIER stages are the sessions whose turn-ends open it;
 * done/failed → terminal; skipped → cancelled; a step still pending inside
 * a terminal run settles as cancelled.
 */
export function workflowToActivities(run: ActivityWorkflowRunSlice): ActivityRecord[] {
  const runTerminal = run.status === "done" || run.status === "failed" || run.status === "cancelled"
  const records: ActivityRecord[] = []
  for (const stage of run.stages) {
    for (const step of stage.steps) {
      const base: ActivityRecordBase = {
        id: `workflow-step:${run.runId}:${stage.index}:${step.index}`,
        kind: "workflow-step",
        ...(step.sessionId ? { sessionId: step.sessionId } : {}),
        sourceRef: `${run.runId}#${stage.index}.${step.index}`,
        source: "workflow",
        title: `Workflow step "${step.label}" (run ${run.runId}, stage ${stage.index})`,
        startedAt: step.startedAt ?? run.startedAt,
        ...(step.endedAt ? { endedAt: step.endedAt } : {}),
        ...(step.error ? { error: step.error } : {}),
      }
      switch (step.status) {
        case "running":
          records.push(record(base, "active"))
          break
        case "done":
          records.push(record(base, "done"))
          break
        case "failed":
          records.push(record(base, "failed"))
          break
        case "skipped":
          records.push(record(base, "cancelled"))
          break
        case "pending": {
          if (runTerminal) {
            records.push(record(base, "cancelled"))
            break
          }
          // The barrier: unfinished steps of earlier stages.
          const refs = run.stages
            .filter(s => s.index < stage.index)
            .flatMap(s => s.steps)
            .filter(s => s.status === "running" || s.status === "pending")
            .flatMap(s => (s.sessionId ? [s.sessionId] : []))
          records.push(
            pendingRecord(base, {
              kind: "stage-barrier",
              refs,
              detail: `waiting on the stage ${stage.index} barrier`,
            }),
          )
          break
        }
      }
    }
  }
  return records
}

// ── pr mapper (source: code-host) ────────────────────────────────────

/**
 * Structural slice of `SessionDescriptor` the PR mapper reads —
 * `openedPrs` rows are `sessions.ts`'s `OpenedPullRequest`.
 */
export interface ActivityPrSession {
  id: string
  openedPrs?: readonly { number: number; url: string; openedAt: string }[]
}

/**
 * A PR's state as the forge last reported it. `merged`/`closed` are
 * immutable verdicts (a merged PR never un-merges), `open` just means "not
 * settled yet". The projector (`activities.ts`) resolves these through its
 * injected `resolvePrState` port and threads them into {@link prToActivities}
 * as a lookup — the mapper itself never fetches.
 */
export type PrResolvedState = "open" | "merged" | "closed"

/**
 * Project a session's opened PRs. A `pr` activity is `pending` on the forge
 * until a resolved state says otherwise: `merged` → `done`, `closed` →
 * `cancelled` (terminal). The resolved state arrives via the pure
 * `resolvedPrState` lookup (threaded like `now` is for staleSince) — the
 * actual forge round-trip lives behind the projector's injected
 * `resolvePrState` port, because it reuses `@agentproto/worktree`'s forge
 * access, a dependency the runtime deliberately does not take. No polling
 * here.
 */
export function prToActivities(
  session: ActivityPrSession,
  opts: { resolvedPrState?: (url: string) => PrResolvedState | undefined } = {},
): ActivityRecord[] {
  return (session.openedPrs ?? []).map(pr => {
    const base = (title: string): ActivityRecordBase => ({
      id: `pr:${session.id}:${pr.number}`,
      kind: "pr",
      sessionId: session.id,
      sourceRef: pr.url,
      source: "code-host",
      title,
      startedAt: pr.openedAt,
    })
    const settled = opts.resolvedPrState?.(pr.url)
    if (settled === "merged") {
      return record(base(`PR #${pr.number} merged (${pr.url})`), "done")
    }
    if (settled === "closed") {
      return record(base(`PR #${pr.number} closed (${pr.url})`), "cancelled")
    }
    return pendingRecord(base(`PR #${pr.number} open (${pr.url})`), {
      kind: "forge",
      refs: [pr.url],
      detail: "open on the forge; settles when the forge reports merged/closed",
    })
  })
}

// ── Query helpers (shared by the MCP tool + HTTP route) ──────────────

/** Filter for `activities_list` / `GET /activities`. */
export interface ActivityListFilter {
  /** Match the record's `sessionId` or any member of its `sessionIds`. */
  sessionId?: string
  state?: ActivityState
  kind?: ActivityKind
  source?: ActivitySource
  /** Include done/failed/cancelled records. Default false — an explicit
   *  terminal `state` filter implies inclusion on its own. */
  includeTerminal?: boolean
}

/** Apply an {@link ActivityListFilter}. Pure; narrowing only. */
export function filterActivities(
  records: readonly ActivityRecord[],
  filter: ActivityListFilter = {},
): ActivityRecord[] {
  const wantsTerminal =
    filter.includeTerminal === true ||
    (filter.state !== undefined && isTerminalActivityState(filter.state))
  return records.filter(rec => {
    if (!wantsTerminal && isTerminalActivityState(rec.state)) return false
    if (filter.state !== undefined && rec.state !== filter.state) return false
    if (filter.kind !== undefined && rec.kind !== filter.kind) return false
    if (filter.source !== undefined && rec.source !== filter.source) return false
    if (filter.sessionId !== undefined) {
      const hit =
        rec.sessionId === filter.sessionId ||
        (rec.sessionIds !== undefined && rec.sessionIds.includes(filter.sessionId))
      if (!hit) return false
    }
    return true
  })
}

/** The `{ active, pending }` counts the query surfaces return. */
export function activityCounts(records: readonly ActivityRecord[]): {
  active: number
  pending: number
} {
  let active = 0
  let pending = 0
  for (const rec of records) {
    if (rec.state === "active") active++
    else if (rec.state === "pending") pending++
  }
  return { active, pending }
}

// Cast-free query-string parsers for the HTTP route (`GET /activities`).
export function parseActivityState(raw: string | null): ActivityState | undefined {
  return ACTIVITY_STATES.find(s => s === raw)
}
export function parseActivityKind(raw: string | null): ActivityKind | undefined {
  return ACTIVITY_KINDS.find(k => k === raw)
}
export function parseActivitySource(raw: string | null): ActivitySource | undefined {
  return ACTIVITY_SOURCES.find(s => s === raw)
}
