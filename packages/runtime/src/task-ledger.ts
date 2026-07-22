/**
 * Task ledger v1 — the multi-party WRITE-model.
 *
 * Where Activity (`activities.ts`) answers "what is *executing/waiting* now"
 * (a projection, read-only), the Task ledger answers "what *should be done*,
 * by whom" — declared intent, a legitimate source of truth, writable by the
 * supervisor that assigns work, the executor that does it, and the human
 * watching both. Modeled on the harness's own TaskCreate/TaskUpdate
 * semantics: nullable claimable owner, informational `blockedBy`, a small
 * status set.
 *
 * State machine (deliberately small):
 *   pending ⇄ in_progress → done | failed
 *   pending | in_progress → cancelled
 *   done → pending only via an explicit reopen (creator/operator; bumps rev,
 *   records who in `meta.reopenedBy` — no silent resurrection)
 *
 * Ownership (two roles, no per-field matrix):
 *   - `owner` absent = claimable. Claim is CAS — succeeds only if `owner` is
 *     absent AND `rev` matches; sets in_progress, appends to `sessions[]`.
 *   - The OWNER (an executor session, or the operator that claimed) may set
 *     status / release itself / attach a note or evidence. The CREATOR and
 *     the OPERATOR may additionally edit title/description/blockedBy,
 *     reassign `owner`, cancel, and reopen.
 *
 * Scoping — implicit boards (no board rows, no board CRUD): a session
 * caller's default board is `tree:<rootSessionId>` (walk `parentSessionId`
 * to the depth-0 root — a supervisor and every executor it spawned share a
 * board automatically); an operator caller's is `ws:<workspaceSlug>`. An
 * explicit `boardId` overrides on every verb. A session caller may reach its
 * own lineage's `tree:*` board but never a *sibling* tree's; non-`tree:`
 * boards are cooperative namespaces in v1 (an explicit board is exactly how
 * a cowork supervisor joins its depth-0 children onto one board).
 *
 * Done integrity — two tiers (enforced only where declared). The ledger
 * never refuses a status write it can't verify, and never launders one
 * either:
 *   - Tier 0 (no `verify`): a done report is accepted and stamped
 *     `verification: {kind:"self-report"|"human"}` — visibly casual.
 *   - Tier 1 (`verify` declared): a done report does NOT transition. The
 *     injected gate-runner (default: the supervisor's own completion-policy
 *     machinery — attach a one-shot `gate: task.verify, then:"emit"` policy
 *     on the owning session; ownerless → the same allowlisted runCommand
 *     path) runs the gate in the background. Green → done +
 *     `verification:{kind:"gate", policyId}`. Red → stays in_progress,
 *     `lastVerifyError` set, `task:changed` fires. The background hop is
 *     load-bearing: the policy gates on the OWNING session's turn-end, and
 *     that turn cannot end while the executor is blocked awaiting the
 *     `task_update` result — awaiting the gate inline would deadlock.
 *   - Evidence shortcut: `{status:"done", evidence:{policyId}}` accepts an
 *     already-passed policy (read via the supervisor slice) without
 *     re-running anything.
 *
 * Liveness (passive): `session:exited` RELEASES (never fails) any
 * in_progress task whose owner died — owner cleared, back to `pending`,
 * reason in `meta`. Same at boot for owners that didn't survive a daemon
 * restart. Tasks are intent, not runs — contrast `routine-runner.ts`'s
 * "interrupted = failed", which is correct for runs and wrong for tasks.
 *
 * Persistence mirrors `routine-runner.ts`/`supervisor.ts` (WP3): opt-in
 * (`persist` defaults on only when a `persistPath` is supplied — unit tests
 * never touch ~/.agentproto), atomic write-tmp+rename, debounced async
 * writes with a sync flush in `dispose()`. Boot loads as-is; the ONLY boot
 * mutation is releasing orphaned in_progress owners.
 *
 * Deliberately NOT here (v1): dependency scheduling (`blockedBy` is
 * display-only), auto-claim, priorities, board CRUD/GC, an Activity.taskId
 * write path (Activity joins at read time over the edges this record already
 * exposes: `sessions[]` + `verification.policyId`), and — never —
 * turn-end-based auto-completion: a turn ending is not a task being done.
 */

import { randomUUID } from "node:crypto"
import { homedir } from "node:os"
import { basename, dirname, join } from "node:path"
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
  promises as fsp,
} from "node:fs"

import type { SessionEventBus, TaskChangedEvent } from "./session-event-bus.js"
import type { GateSpec, JudgeGateSpec } from "./supervisor.js"
import {
  runCommand as defaultRunCommand,
  loadAllowlist,
} from "./command-tools.js"
import type { RunCommandInput, ExecuteResult } from "./command-tools.js"

// ── Data model ───────────────────────────────────────────────────────

export const TASK_STATUSES = [
  "pending",
  "in_progress",
  "done",
  "failed",
  "cancelled",
] as const
export type TaskStatus = (typeof TASK_STATUSES)[number]

/** Parse a raw query/body value into a TaskStatus, or undefined when it
 *  isn't one — the `parseActivityState` idiom for the `/tasks` routes. */
export function parseTaskStatus(raw: string | null | undefined): TaskStatus | undefined {
  return TASK_STATUSES.find(s => s === raw)
}

/** Closed (terminal) task statuses — excluded from `list()` by default. */
export function isClosedTaskStatus(status: TaskStatus): boolean {
  return status === "done" || status === "failed" || status === "cancelled"
}

/**
 * How a `done` was reached — never absent on a done task, and surfaced
 * verbatim in every read so a UI can render self-reported done visually
 * distinct from a gate-passed one ("gate passed", never "verified correct").
 */
export type TaskVerification =
  | { kind: "self-report"; by: string; ts: string }
  | { kind: "gate"; policyId?: string; exitCode?: number; ts: string }
  | { kind: "human"; ts: string }

export interface TaskRecord {
  taskId: string
  /** Scope — see the board rules in the module docblock. */
  boardId: string
  title: string
  description?: string
  status: TaskStatus
  /** sessionId | "human" | "operator"; ABSENT = claimable. */
  owner?: string
  /** Caller identity at create time: a sessionId or "operator". */
  createdBy: string
  /** INFORMATIONAL in v1 — no scheduler reads it. */
  blockedBy?: string[]
  /** Every session that ever claimed this task (append-only) — one of the
   *  two edges the Activity projector will join on later. */
  sessions?: string[]
  /** OPT-IN done-gate. Reuses the supervisor's GateSpec verbatim, so shell
   *  and judge gates both work unchanged. */
  verify?: GateSpec
  /** How done was reached — never absent on `done`. Its `policyId` is the
   *  second Activity join edge. */
  verification?: TaskVerification
  /** Why the last Tier-1 done report did NOT transition. Cleared on a
   *  successful done. */
  lastVerifyError?: string
  /** Optimistic-concurrency token — every write CASes on it. */
  rev: number
  createdAt: string
  updatedAt: string
  closedAt?: string
  /** Free-form provenance: prUrl, worktreePath, actionId, release reasons. */
  meta?: Record<string, string>
}

// ── Caller identity ──────────────────────────────────────────────────

/**
 * Who is talking to the ledger. A spawned child arrives through the scoped
 * orchestrator gateway carrying `callerScope.ownerSessionId`
 * (orchestration-tools.ts) → `{kind:"session"}`. The root `/mcp` endpoint
 * and the `/tasks` HTTP routes are operator context.
 */
export type TaskCaller =
  | { kind: "operator" }
  | { kind: "session"; sessionId: string }

/** Owner values that are NOT session ids — never released on session death. */
const NON_SESSION_OWNERS: readonly string[] = ["human", "operator"]

// ── Structural dependency slices ─────────────────────────────────────
// Narrow slices (the reconciler's `ReconcilerRegistry` pattern): the real
// SessionsRegistry / CompletionPolicySupervisor satisfy them structurally,
// and tests fake them without casts.

/** What the ledger reads off one session descriptor. */
export interface TaskLedgerSessionSlice {
  parentSessionId?: string
  workspaceSlug?: string
  status?: string
  cwd?: string
}

/** The registry slice — `SessionsRegistry.get` satisfies it. */
export interface TaskLedgerRegistry {
  get(id: string): TaskLedgerSessionSlice | undefined
}

/**
 * The supervisor slice the ledger (and its default gate-runner) needs —
 * `CompletionPolicySupervisor` satisfies it. `attach` is only ever called
 * with a one-shot emit policy; `getStatus` backs the evidence shortcut;
 * `onSettle` is the single reliable settlement signal (some terminal
 * transitions emit no bus event — see supervisor.ts).
 */
export interface TaskVerifySupervisor {
  attach(input: { sessionId: string; gate: GateSpec; then: "emit" }): {
    policyId: string
  }
  getStatus(policyId: string):
    | { status: string; lastGate?: { exitCode: number }; error?: string }
    | undefined
  onSettle(cb: (policyId: string) => void): () => void
}

// ── Gate-runner port ─────────────────────────────────────────────────

export interface TaskGateOutcome {
  passed: boolean
  /** The completion policy that ran the gate, when one did — recorded on
   *  `verification.policyId` so Activity can join later. */
  policyId?: string
  exitCode?: number
  /** Why the gate failed — lands on `lastVerifyError`. */
  error?: string
}

/**
 * The injectable Tier-1 verification port. `ownerSessionId` is present when
 * the task's owner is a session (attach a one-shot policy on it); absent for
 * an ownerless context (human/operator owner, dead session) where only a
 * direct shell run makes sense. Tests inject a fake so no real policy ever
 * spawns; production wires {@link createSupervisorTaskGateRunner}.
 */
export type TaskGateRunner = (input: {
  gate: GateSpec
  ownerSessionId?: string
  /** cwd hint for the ownerless shell path (e.g. the dead owner's cwd). */
  cwd?: string
}) => Promise<TaskGateOutcome>

/** Narrow a gate spec to the judge variant (mirrors supervisor.ts). */
function isJudgeGateSpec(gate: GateSpec): gate is JudgeGateSpec {
  return "judge" in gate
}

/** How long the default gate-runner waits for the one-shot policy to settle
 *  before giving up. Generous: the policy gates on the owning session's NEXT
 *  turn-end, which can be minutes away. */
const DEFAULT_VERIFY_SETTLE_TIMEOUT_MS = 10 * 60_000

/**
 * The production gate-runner: Tier-1 done through the supervisor's existing
 * completion-policy machinery. Owner session alive → attach a one-shot
 * `{gate, then:"emit"}` policy on it and wait for settlement (done → passed;
 * blocked → failed with the gate's exit code; cancelled → the owner exited
 * before the gate could run). Ownerless → run a shell gate directly through
 * the same allowlisted runCommand path command_execute and the supervisor
 * use (judge gates need a live owning session and fail-safe to FAIL).
 */
export function createSupervisorTaskGateRunner(opts: {
  supervisor: TaskVerifySupervisor
  registry: TaskLedgerRegistry
  /** Workspace root — anchors the allowlist + the ownerless gate cwd. */
  workspace: string
  /** Inject the command runner (tests mock it). Defaults to the host's. */
  runCommand?: (input: RunCommandInput) => Promise<ExecuteResult>
  /** Max wait for the one-shot policy to settle. Default 10 minutes. */
  settleTimeoutMs?: number
}): TaskGateRunner {
  const { supervisor, registry, workspace } = opts
  const exec = opts.runCommand ?? defaultRunCommand
  const settleTimeoutMs = opts.settleTimeoutMs ?? DEFAULT_VERIFY_SETTLE_TIMEOUT_MS

  const waitForSettle = (policyId: string): Promise<TaskGateOutcome> =>
    new Promise(resolve => {
      let settled = false
      const finish = (outcome: TaskGateOutcome): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        unsub()
        resolve(outcome)
      }
      const read = (): void => {
        const state = supervisor.getStatus(policyId)
        if (!state) {
          finish({ passed: false, policyId, error: "verify policy vanished" })
          return
        }
        if (state.status === "done") {
          finish({
            passed: true,
            policyId,
            exitCode: state.lastGate?.exitCode ?? 0,
          })
        } else if (state.status === "blocked") {
          finish({
            passed: false,
            policyId,
            ...(state.lastGate ? { exitCode: state.lastGate.exitCode } : {}),
            error:
              state.error ??
              `verify gate failed (exit ${state.lastGate?.exitCode ?? "?"})`,
          })
        } else if (state.status === "cancelled") {
          finish({
            passed: false,
            policyId,
            error: "owner session exited before the verify gate ran",
          })
        }
        // Any other status (watching/gating/…) → keep waiting.
      }
      const timer = setTimeout(() => {
        finish({
          passed: false,
          policyId,
          error: `verify gate did not settle within ${settleTimeoutMs}ms`,
        })
      }, settleTimeoutMs)
      const unsub = supervisor.onSettle(id => {
        if (id === policyId) read()
      })
      // The policy may have settled between attach and this subscription
      // (e.g. an attach on an already-finished turn) — check once.
      read()
    })

  return async ({ gate, ownerSessionId, cwd }) => {
    const ownerDesc = ownerSessionId ? registry.get(ownerSessionId) : undefined
    const ownerAlive =
      !!ownerDesc &&
      (ownerDesc.status === "running" || ownerDesc.status === "starting")

    if (ownerSessionId && ownerAlive) {
      let policyId: string
      try {
        policyId = supervisor.attach({
          sessionId: ownerSessionId,
          gate,
          then: "emit",
        }).policyId
      } catch (err) {
        return {
          passed: false,
          error: `verify policy attach failed: ${err instanceof Error ? err.message : String(err)}`,
        }
      }
      return waitForSettle(policyId)
    }

    // Ownerless context (human/operator owner, or a dead session): a judge
    // gate has no session to run against — fail-safe. A shell gate runs
    // directly through the same allowlist + runner the supervisor uses.
    if (isJudgeGateSpec(gate)) {
      return {
        passed: false,
        error: "judge verify gate requires a live owning session",
      }
    }
    try {
      const allowlist = await loadAllowlist(workspace)
      const baseName = basename(gate.command)
      if (!allowlist.has(baseName)) {
        return {
          passed: false,
          error: `verify gate command '${baseName}' not in allowlist`,
        }
      }
      const result = await exec({
        command: gate.command,
        args: gate.args ?? [],
        cwd: gate.cwd ?? cwd ?? workspace,
        timeoutMs: gate.timeoutMs ?? 60_000,
      })
      return result.exitCode === 0
        ? { passed: true, exitCode: 0 }
        : {
            passed: false,
            exitCode: result.exitCode,
            error: `verify gate failed (exit ${result.exitCode})`,
          }
    } catch (err) {
      return {
        passed: false,
        error: err instanceof Error ? err.message : String(err),
      }
    }
  }
}

// ── Public verb inputs / results ─────────────────────────────────────

export interface TaskCreateInput {
  title: string
  description?: string
  /** Explicit board override. Absent → resolved from the caller. */
  boardId?: string
  /** Pre-assign an owner (a sessionId, "human", or "operator"). The task
   *  stays `pending` — assignment is not a start. */
  owner?: string
  blockedBy?: string[]
  verify?: GateSpec
  meta?: Record<string, string>
}

export interface TaskListFilter {
  boardId?: string
  status?: TaskStatus
  /** Include done/failed/cancelled. Default false (an explicit closed
   *  `status` filter implies it). */
  includeClosed?: boolean
}

export interface TaskClaimInput {
  taskId: string
  rev: number
}

export interface TaskUpdateInput {
  taskId: string
  rev: number
  status?: TaskStatus
  title?: string
  description?: string
  blockedBy?: string[]
  /** Reassign (a string — creator/operator) or release (`null` — the owner
   *  itself, or creator/operator). */
  owner?: string | null
  /** Evidence shortcut for `status:"done"`: an already-passed policy. */
  evidence?: { policyId: string }
  /** Free-text note, stamped into `meta.note` (last-write-wins). */
  note?: string
}

/**
 * Every write verb answers with this three-way union: applied / rev-CAS
 * conflict (rebase off `current`) / refused. `verifying: true` marks the
 * Tier-1 done path: the write was ACCEPTED but the status has not
 * transitioned yet — the gate runs in the background and announces its
 * outcome via `task:changed`.
 */
export type TaskWriteResult =
  | { ok: true; task: TaskRecord; verifying?: boolean }
  | { ok: false; conflict: true; current: TaskRecord }
  | { ok: false; conflict: false; error: string }

export interface TaskLedger {
  create(input: TaskCreateInput, caller: TaskCaller): TaskWriteResult
  list(filter: TaskListFilter | undefined, caller: TaskCaller): TaskRecord[]
  get(taskId: string, caller: TaskCaller): TaskRecord | undefined
  claim(input: TaskClaimInput, caller: TaskCaller): TaskWriteResult
  update(input: TaskUpdateInput, caller: TaskCaller): TaskWriteResult
  /** The caller's default board — `tree:<root>` for a session caller,
   *  `ws:<workspaceSlug>` for the operator. Exposed so the tool/HTTP
   *  layers can echo it without re-deriving lineage. */
  resolveBoardId(caller: TaskCaller, explicit?: string): string
  /** Detach bus subscriptions, cancel the debounce timer, sync-flush. */
  dispose(): void
}

// ── Persistence helpers ──────────────────────────────────────────────

const DEFAULT_PERSIST_PATH = (): string =>
  join(homedir(), ".agentproto", "tasks.json")

const PERSIST_DEBOUNCE_MS = 1_500

function loadTasks(persistPath: string): Map<string, TaskRecord> {
  const result = new Map<string, TaskRecord>()
  if (!existsSync(persistPath)) return result
  let raw: string
  try {
    raw = readFileSync(persistPath, "utf8")
  } catch {
    return result
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    // Malformed file — start empty (same recovery policy as routine-runner).
    return result
  }
  if (!Array.isArray(parsed)) return result
  for (const item of parsed) {
    if (!isPersistedTaskRecord(item)) continue
    result.set(item.taskId, item)
  }
  return result
}

/**
 * Minimal shape check (taskId + a known status + rev); remaining fields are
 * trusted as-written — the "malformed = ignored" loader policy shared with
 * routine-runner / supervisor / tunnel-registry, expressed as a guard
 * instead of a cast.
 */
function isPersistedTaskRecord(value: unknown): value is TaskRecord {
  if (typeof value !== "object" || value === null) return false
  if (!("taskId" in value) || typeof value.taskId !== "string") return false
  if (!("status" in value) || typeof value.status !== "string") return false
  if (parseTaskStatus(value.status) === undefined) return false
  if (!("rev" in value) || typeof value.rev !== "number") return false
  return true
}

function serializeTasks(tasks: Map<string, TaskRecord>): string {
  return JSON.stringify(Array.from(tasks.values()), null, 2) + "\n"
}

// ── Factory ──────────────────────────────────────────────────────────

export function createTaskLedger(opts: {
  registry: TaskLedgerRegistry
  sessionEvents: SessionEventBus
  supervisor: TaskVerifySupervisor
  /** Workspace root for the default gate-runner's ownerless shell path.
   *  Defaults to `process.cwd()` — production passes the gateway's. */
  workspace?: string
  /** Inject the Tier-1 verification port (tests). Defaults to
   *  {@link createSupervisorTaskGateRunner} over `supervisor`. */
  gateRunner?: TaskGateRunner
  /** Slug behind the operator's default `ws:<slug>` board. Default "default". */
  operatorWorkspaceSlug?: string
  /** Absolute path for the persistence file. Defaults to ~/.agentproto/tasks.json */
  persistPath?: string
  /**
   * Enable filesystem persistence. Defaults to `true` when `persistPath` is
   * explicitly supplied, `false` otherwise — same opt-in as routine-runner /
   * supervisor, so unit tests never write to ~/.agentproto/. Production
   * `createGateway` passes `persist: true`.
   */
  persist?: boolean
}): TaskLedger {
  const { registry, sessionEvents, supervisor } = opts
  const workspace = opts.workspace ?? process.cwd()
  const persistPath = opts.persistPath ?? DEFAULT_PERSIST_PATH()
  const persist = opts.persist ?? (opts.persistPath !== undefined)
  const operatorBoardId = `ws:${opts.operatorWorkspaceSlug ?? "default"}`
  const gateRunner =
    opts.gateRunner ??
    createSupervisorTaskGateRunner({ supervisor, registry, workspace })

  const tasks = persist ? loadTasks(persistPath) : new Map<string, TaskRecord>()
  /** taskIds with a Tier-1 gate currently in flight — one at a time. */
  const verifying = new Set<string>()
  let persistTimer: ReturnType<typeof setTimeout> | null = null
  let disposed = false

  // ── persistence (WP3 pattern: debounced async, sync flush at dispose) ─

  const writeSnapshotSync = (): void => {
    try {
      mkdirSync(dirname(persistPath), { recursive: true })
      const tmp = `${persistPath}.tmp.${process.pid}`
      writeFileSync(tmp, serializeTasks(tasks), "utf8")
      renameSync(tmp, persistPath)
    } catch {
      // Best-effort — a write failure must not crash the daemon.
    }
  }

  const schedulePersist = (): void => {
    if (!persist || disposed) return
    if (persistTimer) clearTimeout(persistTimer)
    persistTimer = setTimeout(() => {
      void (async () => {
        try {
          await fsp.mkdir(dirname(persistPath), { recursive: true })
          const tmp = `${persistPath}.tmp.${process.pid}`
          await fsp.writeFile(tmp, serializeTasks(tasks), "utf8")
          await fsp.rename(tmp, persistPath)
        } catch {
          // Best-effort, same as the sync path.
        }
      })()
    }, PERSIST_DEBOUNCE_MS)
  }

  // ── board resolution + access ────────────────────────────────────

  /** Walk `parentSessionId` to the depth-0 root (cycle-guarded). A session
   *  the registry doesn't know is its own root. */
  const rootOf = (sessionId: string): string => {
    let current = sessionId
    const seen = new Set<string>()
    while (!seen.has(current)) {
      seen.add(current)
      const parent = registry.get(current)?.parentSessionId
      if (!parent) break
      current = parent
    }
    return current
  }

  const resolveBoardId = (caller: TaskCaller, explicit?: string): string => {
    if (explicit) return explicit
    if (caller.kind === "session") return `tree:${rootOf(caller.sessionId)}`
    return operatorBoardId
  }

  /**
   * May this caller touch this board at all? Operator → everything. A
   * session caller may reach any `tree:*` board within its OWN lineage
   * (same root — covers its shared supervisor board, its private board, and
   * any descendant's) but never a sibling tree's. Non-`tree:` boards are
   * cooperative namespaces in v1 — that is exactly the explicit-board
   * escape hatch a cowork supervisor uses to join its depth-0 children.
   */
  const canAccessBoard = (caller: TaskCaller, boardId: string): boolean => {
    if (caller.kind === "operator") return true
    if (!boardId.startsWith("tree:")) return true
    const target = boardId.slice("tree:".length)
    return rootOf(target) === rootOf(caller.sessionId)
  }

  // ── shared internals ─────────────────────────────────────────────

  const callerId = (caller: TaskCaller): string =>
    caller.kind === "session" ? caller.sessionId : "operator"

  const isManager = (caller: TaskCaller, task: TaskRecord): boolean =>
    caller.kind === "operator" ||
    (caller.kind === "session" && caller.sessionId === task.createdBy)

  const isOwner = (caller: TaskCaller, task: TaskRecord): boolean =>
    task.owner !== undefined &&
    (caller.kind === "session"
      ? caller.sessionId === task.owner
      : task.owner === "operator" || task.owner === "human")

  const emitChanged = (
    task: TaskRecord,
    change: TaskChangedEvent["change"],
    sessionId?: string,
  ): void => {
    sessionEvents.emit({
      type: "task:changed",
      taskId: task.taskId,
      boardId: task.boardId,
      change,
      status: task.status,
      rev: task.rev,
      ...(sessionId ? { sessionId } : {}),
      ts: new Date().toISOString(),
    })
  }

  const touch = (task: TaskRecord): void => {
    task.rev++
    task.updatedAt = new Date().toISOString()
  }

  const notFound = (taskId: string): TaskWriteResult => ({
    ok: false,
    conflict: false,
    error: `task "${taskId}" not found`,
  })

  /** Look up a task the caller may see. Inaccessible reads as absent — no
   *  information leak about a sibling tree's board (the policy-tools rule). */
  const lookup = (taskId: string, caller: TaskCaller): TaskRecord | undefined => {
    const task = tasks.get(taskId)
    if (!task) return undefined
    if (!canAccessBoard(caller, task.boardId)) return undefined
    return task
  }

  const setMeta = (task: TaskRecord, key: string, value: string): void => {
    task.meta = { ...(task.meta ?? {}), [key]: value }
  }

  /** Release an in_progress task back to `pending` (owner death / boot). */
  const releaseTask = (task: TaskRecord, reason: string, announce: boolean): void => {
    const dead = task.owner
    delete task.owner
    task.status = "pending"
    setMeta(task, "releasedReason", reason)
    touch(task)
    if (announce) emitChanged(task, "released", dead)
    schedulePersist()
  }

  // ── boot recovery ────────────────────────────────────────────────
  // Load as-is; the ONLY mutation is releasing orphaned in_progress owners
  // whose session did not survive the restart. Never fail them — tasks are
  // intent, not runs. Silent (no events): nothing changed that a subscriber
  // saw happen, mirroring the activity projector's silent prime.

  for (const task of tasks.values()) {
    if (task.status !== "in_progress") continue
    if (!task.owner || NON_SESSION_OWNERS.includes(task.owner)) continue
    const desc = registry.get(task.owner)
    const alive =
      !!desc && (desc.status === "running" || desc.status === "starting")
    if (!alive) releaseTask(task, "daemon-restart", false)
  }

  // ── owner-death release (passive liveness) ───────────────────────

  const unsubscribeExited = sessionEvents.on("session:exited", ev => {
    for (const task of tasks.values()) {
      if (task.status !== "in_progress") continue
      if (task.owner !== ev.sessionId) continue
      releaseTask(
        task,
        ev.reason === "daemon-restart" ? "daemon-restart" : "owner-session-exited",
        true,
      )
    }
  })

  // ── Tier-1 verification (background) ─────────────────────────────

  const settleVerify = (taskId: string, outcome: TaskGateOutcome): void => {
    verifying.delete(taskId)
    const task = tasks.get(taskId)
    if (!task) return
    // The task may have moved while the gate ran (released on owner death,
    // cancelled by the creator). A stale outcome must not resurrect it.
    if (task.status !== "in_progress") return
    if (outcome.passed) {
      task.status = "done"
      task.verification = {
        kind: "gate",
        ...(outcome.policyId ? { policyId: outcome.policyId } : {}),
        ...(outcome.exitCode !== undefined ? { exitCode: outcome.exitCode } : {}),
        ts: new Date().toISOString(),
      }
      delete task.lastVerifyError
      task.closedAt = new Date().toISOString()
    } else {
      task.lastVerifyError =
        outcome.error ?? `verify gate failed (exit ${outcome.exitCode ?? "?"})`
    }
    touch(task)
    // Red or green, announce — a supervisor's own onFail nudge reacts to
    // the red one.
    emitChanged(task, "status")
    schedulePersist()
  }

  const kickVerify = (task: TaskRecord): void => {
    const gate = task.verify
    if (!gate) return
    verifying.add(task.taskId)
    const ownerSessionId =
      task.owner && !NON_SESSION_OWNERS.includes(task.owner)
        ? task.owner
        : undefined
    const cwd = ownerSessionId ? registry.get(ownerSessionId)?.cwd : undefined
    void gateRunner({
      gate,
      ...(ownerSessionId ? { ownerSessionId } : {}),
      ...(cwd ? { cwd } : {}),
    })
      .catch((err: unknown): TaskGateOutcome => ({
        passed: false,
        error: err instanceof Error ? err.message : String(err),
      }))
      .then(outcome => settleVerify(task.taskId, outcome))
  }

  // ── status transitions ───────────────────────────────────────────

  const ALLOWED_TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
    pending: ["in_progress", "cancelled"],
    in_progress: ["pending", "done", "failed", "cancelled"],
    // done → pending is the explicit reopen verb (manager-only, checked
    // separately); failed/cancelled are terminal in v1.
    done: ["pending"],
    failed: [],
    cancelled: [],
  }

  // ── verbs ────────────────────────────────────────────────────────

  const create = (input: TaskCreateInput, caller: TaskCaller): TaskWriteResult => {
    if (typeof input.title !== "string" || input.title.trim().length === 0) {
      return { ok: false, conflict: false, error: "task_create requires a non-empty title" }
    }
    const boardId = resolveBoardId(caller, input.boardId)
    if (!canAccessBoard(caller, boardId)) {
      return {
        ok: false,
        conflict: false,
        error: `board "${boardId}" is outside the caller's lineage`,
      }
    }
    const now = new Date().toISOString()
    const task: TaskRecord = {
      taskId: `task_${randomUUID().slice(0, 8)}`,
      boardId,
      title: input.title.trim(),
      ...(input.description !== undefined ? { description: input.description } : {}),
      status: "pending",
      ...(input.owner !== undefined ? { owner: input.owner } : {}),
      createdBy: callerId(caller),
      ...(input.blockedBy && input.blockedBy.length > 0
        ? { blockedBy: [...input.blockedBy] }
        : {}),
      ...(input.verify !== undefined ? { verify: input.verify } : {}),
      rev: 0,
      createdAt: now,
      updatedAt: now,
      ...(input.meta !== undefined ? { meta: { ...input.meta } } : {}),
    }
    tasks.set(task.taskId, task)
    emitChanged(task, "created", caller.kind === "session" ? caller.sessionId : undefined)
    schedulePersist()
    return { ok: true, task }
  }

  const list = (
    filter: TaskListFilter | undefined,
    caller: TaskCaller,
  ): TaskRecord[] => {
    const boardId = resolveBoardId(caller, filter?.boardId)
    if (!canAccessBoard(caller, boardId)) return []
    const includeClosed =
      filter?.includeClosed === true ||
      (filter?.status !== undefined && isClosedTaskStatus(filter.status))
    return Array.from(tasks.values())
      .filter(t => t.boardId === boardId)
      .filter(t => (filter?.status !== undefined ? t.status === filter.status : true))
      .filter(t => includeClosed || !isClosedTaskStatus(t.status))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  }

  const claim = (input: TaskClaimInput, caller: TaskCaller): TaskWriteResult => {
    const task = lookup(input.taskId, caller)
    if (!task) return notFound(input.taskId)
    // The CAS: owner must be ABSENT and rev must match. A lost race — either
    // shape — answers with the current record so the caller rebases instead
    // of double-assigning.
    if (input.rev !== task.rev || task.owner !== undefined) {
      return { ok: false, conflict: true, current: task }
    }
    if (task.status !== "pending") {
      return {
        ok: false,
        conflict: false,
        error: `cannot claim a ${task.status} task`,
      }
    }
    task.owner = callerId(caller)
    task.status = "in_progress"
    if (caller.kind === "session") {
      task.sessions = [...(task.sessions ?? []), caller.sessionId]
    }
    touch(task)
    emitChanged(task, "claimed", caller.kind === "session" ? caller.sessionId : undefined)
    schedulePersist()
    return { ok: true, task }
  }

  const update = (input: TaskUpdateInput, caller: TaskCaller): TaskWriteResult => {
    const task = lookup(input.taskId, caller)
    if (!task) return notFound(input.taskId)
    if (input.rev !== task.rev) {
      return { ok: false, conflict: true, current: task }
    }

    const manager = isManager(caller, task)
    const owner = isOwner(caller, task)
    if (!manager && !owner) {
      return {
        ok: false,
        conflict: false,
        error:
          "only the task's owner, its creator, or the operator may update it",
      }
    }

    // Manager-only edits: title/description/blockedBy + owner reassignment.
    const wantsFieldEdit =
      input.title !== undefined ||
      input.description !== undefined ||
      input.blockedBy !== undefined
    const wantsReassign = typeof input.owner === "string"
    if ((wantsFieldEdit || wantsReassign) && !manager) {
      return {
        ok: false,
        conflict: false,
        error:
          "only the creator or the operator may edit fields or reassign the owner",
      }
    }
    const wantsRelease = input.owner === null
    if (wantsRelease && !owner && !manager) {
      return {
        ok: false,
        conflict: false,
        error: "only the owner, the creator, or the operator may release a task",
      }
    }
    const wantsStatus = input.status !== undefined && input.status !== task.status
    if (wantsRelease && wantsStatus) {
      // A release already implies its own status move (in_progress →
      // pending) — combining it with an explicit transition is ambiguous.
      return {
        ok: false,
        conflict: false,
        error: "owner:null (release) cannot be combined with a status change",
      }
    }

    // ── status transition (validated + two-tier done) ──────────────
    // Every refusal above/below happens BEFORE any mutation, so a rejected
    // write leaves the record byte-identical (and its rev untouched).
    if (wantsStatus && input.status !== undefined) {
      const target = input.status
      if (!ALLOWED_TRANSITIONS[task.status].includes(target)) {
        return {
          ok: false,
          conflict: false,
          error: `invalid transition ${task.status} → ${target}`,
        }
      }
      // cancel + reopen are manager verbs.
      if (target === "cancelled" && !manager) {
        return {
          ok: false,
          conflict: false,
          error: "only the creator or the operator may cancel a task",
        }
      }
      const isReopen = task.status === "done" && target === "pending"
      if (isReopen && !manager) {
        return {
          ok: false,
          conflict: false,
          error: "only the creator or the operator may reopen a done task",
        }
      }
      // A reassignment riding along applies first, so
      // `{owner:"sess_x", status:"in_progress"}` works in one write.
      const ownerAfter = wantsReassign && typeof input.owner === "string"
        ? input.owner
        : task.owner
      if (target === "in_progress" && ownerAfter === undefined) {
        return {
          ok: false,
          conflict: false,
          error: "cannot start an unowned task — claim it first (task_claim)",
        }
      }

      // Remaining done-tier validations — still no mutation yet.
      let evidenceVerification: TaskVerification | undefined
      if (target === "done") {
        if (verifying.has(task.taskId)) {
          return {
            ok: false,
            conflict: false,
            error: "a verify gate is already running for this task",
          }
        }
        if (input.evidence) {
          // Evidence shortcut: an already-passed policy closes the task
          // without re-running anything.
          const policyId = input.evidence.policyId
          const state = supervisor.getStatus(policyId)
          const gatePassed =
            !!state &&
            state.status === "done" &&
            (state.lastGate === undefined || state.lastGate.exitCode === 0)
          if (!gatePassed) {
            return {
              ok: false,
              conflict: false,
              error: `evidence policy "${policyId}" is not a passed gate`,
            }
          }
          evidenceVerification = {
            kind: "gate",
            policyId,
            ...(state.lastGate ? { exitCode: state.lastGate.exitCode } : {}),
            ts: new Date().toISOString(),
          }
        }
      }

      // ── everything validated — apply, in order: reassign → reopen
      // bookkeeping → the transition itself.
      if (wantsReassign && typeof input.owner === "string") {
        task.owner = input.owner
        // Only session owners land in the sessions[] edge — "human"/
        // "operator" aren't sessions Activity could ever join on.
        if (!NON_SESSION_OWNERS.includes(input.owner)) {
          task.sessions = [...(task.sessions ?? []), input.owner]
        }
      }
      if (isReopen) {
        // No silent resurrection: record who reopened, clear the closed
        // state.
        setMeta(task, "reopenedBy", callerId(caller))
        delete task.closedAt
        delete task.verification
      }

      if (target === "done") {
        if (evidenceVerification) {
          task.verification = evidenceVerification
        } else if (task.verify) {
          // Tier 1: a done report does NOT transition — the gate decides,
          // in the background (see the module docblock for why inline
          // awaiting would deadlock on the owner's own turn). Edits riding
          // along still land (and bump rev, keeping the CAS honest); the
          // status answer arrives later as its own `task:changed`.
          const hadSideEdits =
            wantsReassign ||
            input.title !== undefined ||
            input.description !== undefined ||
            input.blockedBy !== undefined ||
            input.note !== undefined
          applySideEdits(task, input)
          if (hadSideEdits) {
            touch(task)
            emitChanged(
              task,
              "edited",
              caller.kind === "session" ? caller.sessionId : undefined,
            )
          }
          kickVerify(task)
          schedulePersist()
          return { ok: true, task, verifying: true }
        } else {
          // Tier 0: accepted, honestly labeled.
          task.verification =
            caller.kind === "session"
              ? { kind: "self-report", by: caller.sessionId, ts: new Date().toISOString() }
              : { kind: "human", ts: new Date().toISOString() }
        }
        delete task.lastVerifyError
      }

      task.status = target
      if (isClosedTaskStatus(target)) {
        task.closedAt = new Date().toISOString()
      }
      applySideEdits(task, input)
      touch(task)
      emitChanged(
        task,
        "status",
        caller.kind === "session" ? caller.sessionId : undefined,
      )
      schedulePersist()
      return { ok: true, task }
    }

    // ── release (owner:null) ───────────────────────────────────────
    if (wantsRelease && task.owner !== undefined) {
      const released = task.owner
      delete task.owner
      if (task.status === "in_progress") task.status = "pending"
      applySideEdits(task, input)
      touch(task)
      emitChanged(task, "released", released)
      schedulePersist()
      return { ok: true, task }
    }

    // ── plain edit (fields / reassign / note) ──────────────────────
    if (wantsReassign && typeof input.owner === "string") {
      task.owner = input.owner
      // Only session owners land in the sessions[] edge — "human"/"operator"
      // aren't sessions the Activity projector could ever join on.
      if (!NON_SESSION_OWNERS.includes(input.owner)) {
        task.sessions = [...(task.sessions ?? []), input.owner]
      }
    }
    applySideEdits(task, input)
    touch(task)
    emitChanged(
      task,
      "edited",
      caller.kind === "session" ? caller.sessionId : undefined,
    )
    schedulePersist()
    return { ok: true, task }
  }

  /** Non-status field edits shared by every accepted write path. ACL was
   *  already checked by the caller. */
  const applySideEdits = (task: TaskRecord, input: TaskUpdateInput): void => {
    if (input.title !== undefined && input.title.trim().length > 0) {
      task.title = input.title.trim()
    }
    if (input.description !== undefined) task.description = input.description
    if (input.blockedBy !== undefined) task.blockedBy = [...input.blockedBy]
    if (input.note !== undefined) setMeta(task, "note", input.note)
  }

  return {
    create,
    list,
    get: (taskId, caller) => lookup(taskId, caller),
    claim,
    update,
    resolveBoardId,
    dispose() {
      if (disposed) return
      disposed = true
      unsubscribeExited()
      if (persistTimer) {
        clearTimeout(persistTimer)
        persistTimer = null
      }
      if (persist) writeSnapshotSync()
    },
  }
}
