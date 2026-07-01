/**
 * Completion-policy supervisor — WP1 + WP2 + WP3 + WP4 + WP5 + WP6 + WP7.
 *
 * WP7 (judge-gate): a gate may be a judge AGENT instead of a shell command —
 * `gate: { judge: { adapter, model?, prompt, timeoutMs? } }`. When the trigger
 * fires the supervisor spawns a short-lived agent (resolveAgentAdapter →
 * spawnAgent), prompts it with the rubric (+ a minimal context tail of the
 * watched session output), waits for its turn-end on the bus, reads the final
 * reply and parses the LAST `VERDICT: PASS|FAIL` line (case-insensitive). PASS
 * = gate pass (then-action), FAIL = gate fail (existing nudge/escalate path).
 * Fail-safe: no resolver / spawn fail / timeout (default 120s) / unparseable
 * verdict → FAIL (+ reason on state.error). The judge session is ALWAYS killed
 * when the gate settles. The judge runs while the policy holds its `gating`
 * slot, so it is accounted for in the WP6 concurrency cap. Persistence: a judge
 * gate left in `gating` at crash is re-armed to `watching` like any active
 * policy and simply re-runs the judge — no in-flight judge is persisted.
 *
 *
 * State machine per attached policy:
 *   watching → gating → acting → done
 *                    ↘ nudging (retries < maxRetries) → watching  (gate failed, nudge sent)
 *                    ↘ blocked                                     (gate failed, retries exhausted)
 *                    ↘ awaiting-ack → done       (then:"commit" + requireHumanAck, ack approve)
 *                                  ↘ cancelled    (ack reject)
 *   watching → cancelled  (watched session exited before turn-end)
 *
 * Trigger: session:turn-end on the watched session(s).
 * Gate: optional shell command via the same allowlist + cwd-anchor as
 *       command_execute. exit 0 = pass.
 * Action (then:"emit"): emits policy:passed / policy:failed on the bus
 *       (readable via session_events_poll).
 *
 * WP5 (then:"commit"): on a GREEN gate, prepare a host-side git commit in the
 * watched session's cwd — `git add -- <explicit paths>` then `git commit -m
 * <message>` via the same allowlisted runCommand path (argv array, shell:false).
 * GUARDRAILS: never `git add -A`/glob, never `git push`, never `--force`, never
 * a branch the policy didn't ask for (commits the cwd's current branch), message
 * passed as argv (no shell injection), empty paths → error (no commit). A `--`
 * separator precedes the paths so a path can never be parsed as a git flag.
 * "nothing to commit" is treated as SUCCESS (idempotent re-commit after a
 * restart). `requireHumanAck` defaults to TRUE: the gate-green transition goes
 * to `awaiting-ack` and emits `policy:commit-ready` (paths + message) instead of
 * committing; the commit runs only on `policy_ack(approve:true)` →
 * `policy:committed` (+ sha) → done; `approve:false` → cancelled. With
 * `requireHumanAck:false` the commit runs directly at the green gate.
 * onFail (WP2): when gate fails, re-prompts the session(s) (sendPrompt) up to
 *       maxRetries times, then transitions to blocked + emits policy:failed.
 *
 * WP3: persists PolicyRunState + input to ~/.agentproto/policies.json (or an
 * injected persistPath). Debounced async write on every transition; sync flush
 * at shutdown(). On boot, active policies (watching/gating/nudging/acting) are
 * re-armed to "watching" and re-subscribed to the bus. Terminal states (done/
 * blocked/cancelled) are kept for history. Session absent at reload → cancelled.
 *
 * WP6 (DAG + concurrency cap):
 *   - CHAINING: a policy may declare `next` — a recursive AttachPolicyInput.
 *     When the policy reaches `done` (emit-passed or commit-committed), the
 *     supervisor automatically attaches `next` as a fresh completion policy on
 *     the session(s) named in its own spec (chaining policies over EXISTING
 *     sessions — this WP does NOT spawn new sessions). The child's policyId is
 *     recorded on the parent as `nextPolicyId`. Chaining is idempotent (a parent
 *     already carrying a `nextPolicyId` never re-chains, so a re-armed/re-acked
 *     parent after a restart won't double-attach). `next` persists as part of the
 *     parent's `input`, so the whole chain survives a restart.
 *   - CONCURRENCY CAP: a daemon-wide cap (`concurrencyCap`, default 8) on how
 *     many policies may be in `gating`/`acting` at once. When a trigger fires
 *     and the cap is already saturated, the policy parks in `queued` (a FIFO
 *     gate queue) instead of gating. As each active policy settles (done /
 *     blocked / awaiting-ack / back-to-watching after a nudge), the queue is
 *     pumped and the oldest queued policy proceeds to gate. Queued policies hold
 *     NO slot, so a chained DAG can't deadlock behind the cap. The queued state
 *     persists and is re-armed to `watching` on reload (then re-evaluated).
 *
 * WP4 (fan-in): a policy may watch a GROUP of sessions (`sessionIds`). The gate
 * runs ONCE, only after EVERY member of the group has finished its turn. Members
 * are tracked in an idempotent `pending` set: a member is removed on its first
 * `session:turn-end`; a repeated turn-end for an already-removed member is a
 * no-op (no double-count). When the set empties → gating.
 *
 * A member that emits `session:exited` is treated as "this member is done": it
 * is removed from the pending set exactly like a turn-end (a dead session will
 * never emit one), so a partially-crashed group can still complete. If every
 * member exits, the set empties and the gate runs once. The one exception is the
 * degenerate group of size 1 (the legacy single-`sessionId` form): a lone
 * watched session that exits has nothing left to gate on, so the policy is
 * cancelled — preserving the original single-session contract.
 *
 * Back-compat: the legacy `sessionId` (single) form is a group of one. `state.
 * sessionId` is retained as the group's representative (group[0]) and is the id
 * carried on policy:passed / policy:failed events.
 */

import { randomUUID } from "node:crypto"
import { basename, dirname } from "node:path"
import { homedir } from "node:os"
import { resolve } from "node:path"
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  promises as fsp,
} from "node:fs"
import type { SessionsRegistry } from "./sessions.js"
import type { SessionEventBus } from "./session-event-bus.js"
import type { AgentAdapterResolver } from "./http-server.js"
import {
  runCommand as defaultRunCommand,
  loadAllowlist,
  makeCwdAnchor,
} from "./command-tools.js"
import type { RunCommandInput, ExecuteResult } from "./command-tools.js"

// ── Public types ─────────────────────────────────────────────────────

export interface ShellGateSpec {
  command: string
  args?: string[]
  /** Working directory for the gate command. Defaults to the watched
   *  session's cwd, anchored to the workspace. */
  cwd?: string
  timeoutMs?: number
}

/**
 * Judge-agent gate (WP7). Instead of a shell command, the gate spawns a
 * short-lived LLM agent (via the daemon's `resolveAgentAdapter`), prompts it
 * with `prompt` (+ a minimal context tail of the watched session output, if
 * readable), waits for its turn to end, reads the final reply and parses a
 * verdict line (`VERDICT: PASS` / `VERDICT: FAIL`, last occurrence,
 * case-insensitive). PASS = gate pass (exit 0 equivalent), FAIL = gate fail
 * (→ the existing nudge/escalate path). Fail-safe: a judge timeout OR an
 * unparseable reply is treated as FAIL. The judge session is always killed
 * when the gate settles (success or failure).
 */
export interface JudgeGateSpec {
  judge: {
    /** Agent CLI adapter slug used to spawn the judge (e.g. "claude-code"). */
    adapter: string
    /** Optional model identifier forwarded to the adapter. */
    model?: string
    /** The rubric / instructions for the judge. The supervisor appends a
     *  fixed instruction to end the reply with `VERDICT: PASS` or
     *  `VERDICT: FAIL`. */
    prompt: string
    /** Max wall-clock for the judge turn before it is killed + FAIL.
     *  Default 120_000ms. */
    timeoutMs?: number
  }
}

/** A gate is either a shell command (exit 0 = pass) or a judge agent. */
export type GateSpec = ShellGateSpec | JudgeGateSpec

/** Narrow a gate spec to the judge variant. */
function isJudgeGate(gate: GateSpec): gate is JudgeGateSpec {
  return typeof (gate as JudgeGateSpec).judge === "object"
}

export interface OnFailSpec {
  /**
   * Message sent to the watched session via sendPrompt when the gate fails.
   * Use the placeholder {code} to embed the actual exit code.
   * Default: "Le gate a échoué (exit {code}). Corrige et termine jusqu'à ce qu'il passe."
   */
  nudge?: string
  /**
   * Maximum number of consecutive gate failures before transitioning to
   * blocked. Must be >= 1. Default: 2.
   */
  maxRetries?: number
}

export interface CommitSpec {
  /**
   * Explicit, literal paths to stage — workspace/cwd-relative. NEVER a glob,
   * NEVER `-A`/`--all`. Staged via `git add -- <paths>` (the `--` guards each
   * path from being parsed as a flag). An empty array is rejected at attach.
   */
  paths: string[]
  /** Commit message. Passed as a single `-m` argv value — no shell. */
  message: string
  /**
   * Human-in-the-loop gate before the commit actually runs. Default TRUE:
   * the green gate transitions to `awaiting-ack` + emits `policy:commit-ready`
   * and waits for `policy_ack`. Set false to commit directly at the green gate.
   */
  requireHumanAck?: boolean
}

export interface AttachPolicyInput {
  /**
   * Session id whose turn-end triggers the policy (single-session / legacy
   * form). Equivalent to `sessionIds: [sessionId]`. Provide this OR
   * `sessionIds`; if both are given, `sessionIds` wins.
   */
  sessionId?: string
  /**
   * Fan-in group (WP4): the gate runs once, only after EVERY listed session
   * has finished its turn (turn-end or exit). Supersedes `sessionId` when
   * present and non-empty. A single-element array behaves like `sessionId`.
   */
  sessionIds?: string[]
  /**
   * Optional gate. Absent → always pass immediately. Either a shell gate
   * (exit 0 = pass) or a judge-agent gate (WP7: `{ judge: {...} }`).
   */
  gate?: GateSpec
  /**
   * Action on a GREEN gate. "emit" (WP1) emits policy:passed. "commit" (WP5)
   * stages explicit paths and commits on the host — see `commit`.
   */
  then: "emit" | "commit"
  /** Required when then === "commit". Ignored otherwise. */
  commit?: CommitSpec
  /**
   * What to do when the gate fails (WP2). Absent → immediately blocked
   * (WP1 behaviour). Present → re-prompt the session up to maxRetries
   * times before blocking; the session must still be running to nudge.
   */
  onFail?: OnFailSpec
  /**
   * DAG chaining (WP6). When this policy reaches `done`, the supervisor
   * automatically attaches `next` as a fresh completion policy. `next` is a
   * full AttachPolicyInput (recursive — it may declare its own `next`), and it
   * carries the session(s) it watches in its own spec. Chaining only attaches
   * policies onto already-running sessions; it never spawns new sessions.
   */
  next?: AttachPolicyInput
}

export type PolicyRunStatus =
  | "watching"
  | "queued"
  | "gating"
  | "acting"
  | "nudging"
  | "awaiting-ack"
  | "done"
  | "blocked"
  | "cancelled"

export interface PolicyRunState {
  policyId: string
  /** Representative session id (the fan-in group's first member, group[0]).
   *  Carried on policy:passed / policy:failed events. */
  sessionId: string
  /** The full fan-in group being watched. Always present; a length-1 group is
   *  the legacy single-session form. */
  sessionIds: string[]
  /** Sessions in the group that have NOT yet finished their turn. The gate
   *  fires once this set empties. Idempotent: a member is removed on its first
   *  turn-end/exit; repeats are no-ops. Reset to the full group on each nudge. */
  pending: string[]
  status: PolicyRunStatus
  /** Number of nudges sent so far (incremented after each nudge round). */
  retries: number
  startedAt: string
  endedAt?: string
  lastGate?: { exitCode: number; at: string }
  /**
   * The exact commit prepared at the green gate (WP5). Set when entering
   * `awaiting-ack` (or just before a direct commit) so that an ack arriving
   * after a daemon restart commits the same paths/message in the same cwd,
   * independent of whether the watched session still exists.
   */
  commitPlan?: { paths: string[]; message: string; cwd: string }
  /** The resulting commit sha once `then:"commit"` has committed. */
  commitSha?: string
  /**
   * DAG chaining (WP6): the policyId of the child policy attached when this
   * policy reached `done`. Set exactly once (idempotent chaining guard).
   */
  nextPolicyId?: string
  error?: string
}

export interface CompletionPolicySupervisor {
  /**
   * Attach a completion policy to an already-running session.
   * Returns immediately with the initial (watching) state.
   * The state machine runs in the background.
   */
  attach(input: AttachPolicyInput): PolicyRunState
  getStatus(policyId: string): PolicyRunState | undefined
  cancel(policyId: string): void
  /**
   * Human acknowledgement for a `then:"commit"` policy parked in
   * `awaiting-ack` (WP5). `approve:true` runs the prepared commit (→ done,
   * emits policy:committed); `approve:false` cancels it (no commit). No-op on
   * any other state. Returns the (possibly updated) state.
   */
  ack(policyId: string, approve: boolean): Promise<PolicyRunState | undefined>
  list(): PolicyRunState[]
  /**
   * Subscribe to policy settlements — fired whenever a policy transitions
   * into a terminal state (done / blocked / cancelled) OR into awaiting-ack.
   * Used by the `/policies/:id/wait` long-poll to block until a policy
   * resolves without reimplementing the state machine's event surface.
   * Returns an unsubscribe fn. The callback receives the policyId; read
   * the full state via `getStatus(policyId)`.
   */
  onSettle(cb: (policyId: string) => void): () => void
  /**
   * Sync flush of the policy snapshot to disk. Call from the daemon
   * stop() path — mirrors sessions.shutdown().
   */
  shutdown(): void
}

// ── Internal ─────────────────────────────────────────────────────────

interface RunEntry {
  input: AttachPolicyInput
  /** Resolved fan-in group (deduped, order-preserved). group[0] is the repr. */
  group: string[]
  /** Live idempotent set of sessions still awaited. Mirrored to state.pending. */
  pending: Set<string>
  state: PolicyRunState
  unsubscribes: Array<() => void>
  cancelled: boolean
  /** Per-entry gate runner, set by armEntry; invoked by the concurrency-cap
   *  queue pump (WP6) when a slot frees. */
  runGate?: () => Promise<void>
}

/**
 * Resolve the watched group from an attach input. `sessionIds` (when present
 * and non-empty) wins over the legacy `sessionId`. Deduped, order-preserved.
 * Throws if neither yields a session id.
 */
function resolveGroup(input: AttachPolicyInput): string[] {
  const raw =
    input.sessionIds && input.sessionIds.length > 0
      ? input.sessionIds
      : input.sessionId
        ? [input.sessionId]
        : []
  const group = Array.from(new Set(raw))
  if (group.length === 0) {
    throw new Error("policy_attach requires sessionId or a non-empty sessionIds")
  }
  return group
}

/** Persisted envelope written to policies.json. */
interface PolicySnapshot {
  savedAt: string
  policies: Array<{ input: AttachPolicyInput; state: PolicyRunState }>
}

const DEFAULT_NUDGE_TEMPLATE =
  "Le gate a échoué (exit {code}). Corrige et termine jusqu'à ce qu'il passe."
const DEFAULT_MAX_RETRIES = 2
/** Judge-gate (WP7) wall-clock default before timeout → kill + FAIL. */
const DEFAULT_JUDGE_TIMEOUT_MS = 120_000
/** Fixed instruction appended to the judge prompt so its verdict is parseable. */
const JUDGE_VERDICT_INSTRUCTION =
  "\n\nWhen you are done, end your reply with a single line containing exactly " +
  "`VERDICT: PASS` (if the criteria are met) or `VERDICT: FAIL` (if not). " +
  "Do not write anything after that line."
/** Strip ANSI escape sequences (mirrors session-tools.stripAnsi). */
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]/g
function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "")
}
/**
 * Parse the judge verdict from its final reply. Scans for `VERDICT: PASS|FAIL`
 * (case-insensitive) and returns the LAST occurrence. Returns null when no
 * verdict line is present → caller treats as FAIL (fail-safe).
 */
function parseVerdict(text: string): "PASS" | "FAIL" | null {
  const re = /VERDICT:\s*(PASS|FAIL)/gi
  let last: "PASS" | "FAIL" | null = null
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    last = m[1]!.toUpperCase() as "PASS" | "FAIL"
  }
  return last
}
const PERSIST_DEBOUNCE_MS = 1_500
/** Daemon-wide default cap on policies concurrently in gating/acting (WP6). */
const DEFAULT_CONCURRENCY_CAP = 8

export const POLICIES_FILE_PATH = (): string =>
  resolve(homedir(), ".agentproto", "policies.json")

// ── Factory ──────────────────────────────────────────────────────────

export function createCompletionPolicySupervisor(opts: {
  registry: SessionsRegistry
  sessionEvents: SessionEventBus
  workspace: string
  /** Override the persist path — used in tests to avoid touching ~/.agentproto. */
  persistPath?: string
  /** Disable persistence entirely (e.g. for unit tests that don't need it). */
  persist?: boolean
  /**
   * Inject the command runner — used by tests to mock git (gate + commit) so
   * no real subprocess/commit runs. Defaults to the host runCommand.
   */
  runCommand?: (input: RunCommandInput) => Promise<ExecuteResult>
  /**
   * Daemon-wide cap on policies concurrently in gating/acting (WP6). Excess
   * triggered policies queue (FIFO) until a slot frees. Default 8. Values < 1
   * are clamped to 1.
   */
  concurrencyCap?: number
  /**
   * Adapter resolver used to spawn a judge agent for a judge-gate (WP7).
   * Same resolver the daemon passes to `agent_start`. When absent, a
   * judge-gate fails fail-safe (FAIL) with a clear reason — shell gates are
   * unaffected.
   */
  resolveAgentAdapter?: AgentAdapterResolver
}): CompletionPolicySupervisor {
  const { registry, sessionEvents, workspace, resolveAgentAdapter } = opts
  const exec = opts.runCommand ?? defaultRunCommand
  const persistPath = opts.persistPath ?? POLICIES_FILE_PATH()
  const cap = Math.max(1, opts.concurrencyCap ?? DEFAULT_CONCURRENCY_CAP)
  /** FIFO queue of entries whose trigger fired while the cap was saturated. */
  const gateQueue: RunEntry[] = []
  // Default false: WP1/WP2 tests (no opts.persist, no opts.persistPath)
  // don't touch ~/.agentproto. Set opts.persist:true in production
  // (createGateway) or supply persistPath to implicitly enable it.
  const persist = opts.persist ?? (opts.persistPath !== undefined)
  const anchorCwd = makeCwdAnchor(workspace)
  const runs = new Map<string, RunEntry>()
  let persistTimer: ReturnType<typeof setTimeout> | null = null
  let shutdownDone = false

  // ── settlement listeners (for /policies/:id/wait long-poll) ──────

  /**
   * Listeners fired whenever a policy reaches a terminal state (done /
   * blocked / cancelled) or parks in awaiting-ack. The HTTP long-poll
   * `GET /policies/:id/wait` subscribes here to block until a policy
   * resolves, mirroring the MCP `policy_status` semantics but as a
   * blocking call. Some transitions (cancel(), ack(false), single-session
   * exit) emit no SessionEventBus event, so this hook is the single
   * reliable signal — see `notifySettled`.
   */
  const settleListeners = new Set<(policyId: string) => void>()
  const notifySettled = (policyId: string): void => {
    for (const cb of settleListeners) {
      try {
        cb(policyId)
      } catch (err) {
        console.warn(
          `[supervisor] onSettle listener threw: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
    }
  }

  // ── persistence helpers ──────────────────────────────────────────

  const buildSnapshot = (): PolicySnapshot => ({
    savedAt: new Date().toISOString(),
    policies: Array.from(runs.values()).map(e => ({
      input: e.input,
      state: e.state,
    })),
  })

  const schedulePersist = (): void => {
    if (!persist) return
    if (persistTimer) clearTimeout(persistTimer)
    persistTimer = setTimeout(() => {
      void (async () => {
        try {
          const snap = buildSnapshot()
          await fsp.mkdir(dirname(persistPath), { recursive: true })
          await fsp.writeFile(
            persistPath,
            JSON.stringify(snap, null, 2) + "\n",
          )
        } catch (err) {
          console.warn(
            `[supervisor] persist failed: ${err instanceof Error ? err.message : String(err)}`,
          )
        }
      })()
    }, PERSIST_DEBOUNCE_MS)
  }

  // ── concurrency cap (WP6) ────────────────────────────────────────

  /** Policies currently holding a slot — i.e. in gating or acting. */
  const countActive = (): number => {
    let n = 0
    for (const e of runs.values()) {
      if (e.state.status === "gating" || e.state.status === "acting") n++
    }
    return n
  }

  /**
   * Release-time pump: while there is a free slot, dequeue the oldest queued
   * entry and run its gate. A dequeued entry is flipped back to `watching` so
   * its runGate() guard passes; runGate() then synchronously sets `gating`
   * (before its first await), so the loop's next countActive() sees the slot
   * taken — no over-admission. Cancelled / no-longer-queued entries are skipped.
   */
  const pumpQueue = (): void => {
    while (gateQueue.length > 0 && countActive() < cap) {
      const entry = gateQueue.shift()!
      if (entry.cancelled || entry.state.status !== "queued") continue
      entry.state.status = "watching"
      schedulePersist()
      void entry.runGate?.()
    }
  }

  // ── DAG chaining (WP6) ───────────────────────────────────────────

  /**
   * When `entry` reaches `done`, attach its `next` policy (if any) onto the
   * session(s) named in the `next` spec. Idempotent: a parent that already
   * carries a `nextPolicyId` never re-chains, so a re-armed or re-acked parent
   * after a restart won't double-attach the child.
   */
  const maybeChain = (entry: RunEntry): void => {
    const next = entry.input.next
    if (!next) return
    if (entry.state.nextPolicyId) return
    try {
      const child = attachPolicy(next)
      entry.state.nextPolicyId = child.policyId
      schedulePersist()
    } catch (err) {
      entry.state.error = `next chain failed: ${err instanceof Error ? err.message : String(err)}`
      schedulePersist()
    }
  }

  // ── commit action (WP5) ──────────────────────────────────────────

  /**
   * Stage explicit paths and commit on the host. Fixed argv, shell:false:
   *   git add -- <paths...>      (the `--` guards paths from flag-parsing)
   *   git commit -m <message>    (message is one argv value, never a shell str)
   *   git rev-parse HEAD         (read back the sha)
   * No `-A`, no glob, no push, no --force, no branch switch — the commit lands
   * on whatever branch the cwd is already on. "nothing to commit" → success.
   */
  async function performCommit(plan: {
    paths: string[]
    message: string
    cwd: string
  }): Promise<{ sha: string } | { error: string }> {
    if (plan.paths.length === 0) {
      return { error: "commit requires a non-empty paths[]" }
    }
    // Defensive: argv-only, but still refuse blatantly unsafe path entries.
    if (plan.paths.some(p => typeof p !== "string" || p.length === 0)) {
      return { error: "commit paths must be non-empty strings" }
    }

    const allowlist = await loadAllowlist(workspace)
    if (!allowlist.has("git")) {
      return { error: "commit command 'git' not in allowlist" }
    }

    const add = await exec({
      command: "git",
      args: ["add", "--", ...plan.paths],
      cwd: plan.cwd,
      timeoutMs: 60_000,
    })
    if (add.exitCode !== 0) {
      return { error: `git add failed (exit ${add.exitCode}): ${add.stderr.trim()}` }
    }

    const commit = await exec({
      command: "git",
      args: ["commit", "-m", plan.message],
      cwd: plan.cwd,
      timeoutMs: 60_000,
    })
    // "nothing to commit" is success — a re-armed policy after a crash may find
    // the tree already committed (design §5.4).
    const out = `${commit.stdout}\n${commit.stderr}`
    const nothingToCommit = /nothing to commit|no changes added|nothing added to commit/i.test(out)
    if (commit.exitCode !== 0 && !nothingToCommit) {
      return { error: `git commit failed (exit ${commit.exitCode}): ${commit.stderr.trim()}` }
    }

    const head = await exec({
      command: "git",
      args: ["rev-parse", "HEAD"],
      cwd: plan.cwd,
      timeoutMs: 30_000,
    })
    if (head.exitCode !== 0) {
      return { error: `git rev-parse HEAD failed (exit ${head.exitCode}): ${head.stderr.trim()}` }
    }
    return { sha: head.stdout.trim() }
  }

  /**
   * Run the prepared commit for `entry` and settle its state. Does NOT touch
   * bus subscriptions (callers handle that). Used by both the direct-commit
   * path and the ack-approve path.
   */
  async function finishCommit(entry: RunEntry): Promise<void> {
    const state = entry.state
    const repr = entry.group[0]!
    const plan = state.commitPlan
    if (!plan) {
      state.status = "blocked"
      state.error = "no commit plan"
      state.endedAt = new Date().toISOString()
      sessionEvents.emit({
        type: "policy:failed",
        policyId: state.policyId,
        sessionId: repr,
        ts: new Date().toISOString(),
      })
      schedulePersist()
      notifySettled(state.policyId)
      return
    }

    const result = await performCommit(plan)
    if ("error" in result) {
      state.status = "blocked"
      state.error = result.error
      state.endedAt = new Date().toISOString()
      sessionEvents.emit({
        type: "policy:failed",
        policyId: state.policyId,
        sessionId: repr,
        ts: new Date().toISOString(),
      })
      schedulePersist()
      notifySettled(state.policyId)
      pumpQueue() // WP6: release the slot this commit held
      return
    }

    state.commitSha = result.sha
    state.status = "done"
    state.endedAt = new Date().toISOString()
    sessionEvents.emit({
      type: "policy:committed",
      policyId: state.policyId,
      sessionId: repr,
      sha: result.sha,
      paths: plan.paths,
      message: plan.message,
      ts: new Date().toISOString(),
    })
    schedulePersist()
    maybeChain(entry) // WP6: attach `next` now that this policy is done
    pumpQueue() // WP6: release the slot this commit held
    notifySettled(state.policyId)
  }

  // ── arm logic (shared by attach() and reload) ────────────────────

  /**
   * Set up bus subscriptions for a run entry. Called both when
   * attaching a fresh policy and when re-arming after reload.
   * The caller is responsible for inserting the entry into `runs`.
   */
  function armEntry(entry: RunEntry): void {
    const { input, state, unsubscribes } = entry
    const group = entry.group
    // Representative session id used for cwd resolution and event payloads.
    // group is guaranteed non-empty by resolveGroup.
    const repr = group[0]!

    // Keep the serializable mirror (state.pending) in sync with the live set.
    const syncPending = () => {
      state.pending = Array.from(entry.pending)
    }

    let settled = false
    const cleanup = () => {
      if (settled) return
      settled = true
      for (const u of unsubscribes) u()
      unsubscribes.length = 0
    }

    const emitFailed = (exitCode: number | undefined, error?: string) => {
      if (error) state.error = error
      state.status = "blocked"
      state.endedAt = new Date().toISOString()
      sessionEvents.emit({
        type: "policy:failed",
        policyId: state.policyId,
        sessionId: repr,
        ...(exitCode !== undefined ? { exitCode } : {}),
        ts: new Date().toISOString(),
      })
      schedulePersist()
      cleanup()
      pumpQueue() // WP6: release the slot (if any) this run held
      notifySettled(state.policyId)
    }

    const act = async (passed: boolean, exitCode: number) => {
      if (entry.cancelled) return
      state.status = "acting"
      schedulePersist()

      if (passed) {
        // WP5: commit action. Prepare the plan in the watched session's cwd.
        if (input.then === "commit") {
          const commit = input.commit!
          const cwd = anchorCwd(registry.get(repr)?.cwd ?? workspace)
          state.commitPlan = {
            paths: commit.paths,
            message: commit.message,
            cwd,
          }
          const requireAck = commit.requireHumanAck !== false // default true
          if (requireAck) {
            // Don't commit yet — park in awaiting-ack and surface the plan.
            state.status = "awaiting-ack"
            schedulePersist()
            sessionEvents.emit({
              type: "policy:commit-ready",
              policyId: state.policyId,
              sessionId: repr,
              paths: commit.paths,
              message: commit.message,
              ts: new Date().toISOString(),
            })
            // Stop watching the bus; policy_ack drives the rest. The entry
            // stays in `runs` so ack() can find it.
            cleanup()
            pumpQueue() // WP6: parked awaiting ack — release the slot
            notifySettled(state.policyId)
            return
          }
          // Unattended commit — run it directly at the green gate.
          // finishCommit handles maybeChain + pumpQueue on settle.
          await finishCommit(entry)
          cleanup()
          return
        }

        // then === "emit" (WP1)
        sessionEvents.emit({
          type: "policy:passed",
          policyId: state.policyId,
          sessionId: repr,
          ts: new Date().toISOString(),
        })
        state.status = "done"
        state.endedAt = new Date().toISOString()
        schedulePersist()
        cleanup()
        maybeChain(entry) // WP6: attach `next` now that this policy is done
        pumpQueue() // WP6: release the slot this run held
        notifySettled(state.policyId)
        return
      }

      // Gate failed — attempt bounded nudge if configured (WP2).
      if (input.onFail !== undefined) {
        const maxRetries = input.onFail.maxRetries ?? DEFAULT_MAX_RETRIES
        if (state.retries < maxRetries) {
          // Nudge every still-running member of the group (fan-in: WP4).
          const running = group.filter(
            id => registry.get(id)?.status === "running",
          )
          if (running.length > 0) {
            const template = input.onFail.nudge ?? DEFAULT_NUDGE_TEMPLATE
            const nudgeMsg = template.replace("{code}", String(exitCode))
            state.status = "nudging"
            schedulePersist()
            try {
              for (const id of running) {
                await registry.sendPrompt(id, nudgeMsg)
              }
            } catch {
              emitFailed(exitCode, "nudge prompt delivery failed")
              return
            }
            state.retries++
            // Reset the fan-in set to the full group and return to watching —
            // bus subscriptions remain active; the gate fires again only once
            // every member has finished another turn.
            entry.pending = new Set(group)
            syncPending()
            state.status = "watching"
            schedulePersist()
            pumpQueue() // WP6: nudged back to watching — release the slot
            return
          }
        }
      }

      // No nudge configured, no running member, or retries exhausted → block
      emitFailed(exitCode)
    }

    /**
     * Read the recent ring-buffer tail of a session (best-effort) — used to
     * give the judge a minimal context of the watched session's output. Mirrors
     * agent_output: attach captures the backfill synchronously, then
     * unsubscribe. Returns "" when the session/attach is unavailable.
     */
    const readTail = (sessionId: string, lastN: number): string => {
      const lines: string[] = []
      let unsub: (() => void) | null = null
      try {
        unsub = registry.attach(sessionId, line => {
          lines.push(line)
        })
      } catch {
        return ""
      }
      if (unsub) unsub()
      return lines.slice(-lastN).map(stripAnsi).join("\n").trim()
    }

    /**
     * WP7: run a judge-agent gate. Spawns a short-lived agent via
     * resolveAgentAdapter, prompts it with the rubric (+ a minimal context tail),
     * waits for its turn-end (or a timeout), parses VERDICT: PASS/FAIL from the
     * final reply, and ALWAYS kills the judge session before returning.
     * Fail-safe: no resolver / spawn failure / timeout / unparseable → FAIL.
     * The judge runs while this policy holds its `gating` slot, so it is already
     * accounted for in the WP6 concurrency cap.
     */
    const runJudge = async (
      spec: JudgeGateSpec["judge"],
    ): Promise<{ passed: boolean; exitCode: number; reason?: string }> => {
      if (!resolveAgentAdapter) {
        return { passed: false, exitCode: 1, reason: "judge gate not enabled (no adapter resolver)" }
      }
      let resolved
      try {
        resolved = await resolveAgentAdapter(spec.adapter)
      } catch (err) {
        return { passed: false, exitCode: 1, reason: `judge adapter resolve failed: ${err instanceof Error ? err.message : String(err)}` }
      }
      if (!resolved) {
        return { passed: false, exitCode: 1, reason: `judge adapter '${spec.adapter}' not found` }
      }

      const cwd = anchorCwd(registry.get(repr)?.cwd ?? workspace)
      const timeoutMs = spec.timeoutMs ?? DEFAULT_JUDGE_TIMEOUT_MS

      // Minimal context: the tail of each watched session's output, if readable.
      const contextBlocks = group
        .map(id => {
          const tail = readTail(id, 60)
          return tail ? `--- output of session ${id} ---\n${tail}` : ""
        })
        .filter(Boolean)
      const context = contextBlocks.length > 0
        ? `\n\nContext — recent output of the watched session(s):\n${contextBlocks.join("\n\n")}`
        : ""
      const fullPrompt = `${spec.prompt}${context}${JUDGE_VERDICT_INSTRUCTION}`

      // Spawn the judge agent.
      let judgeId: string
      try {
        const agentSession = await resolved.startSession({
          cwd,
          ...(spec.model ? { model: spec.model } : {}),
        })
        const desc = registry.spawnAgent({
          workspaceSlug: "default",
          cwd,
          agentSession,
          adapterSlug: spec.adapter,
          label: `judge:${state.policyId}`,
          ...(resolved.commandPreview ? { commandPreview: resolved.commandPreview } : {}),
        })
        judgeId = desc.id
      } catch (err) {
        return { passed: false, exitCode: 1, reason: `judge spawn failed: ${err instanceof Error ? err.message : String(err)}` }
      }

      try {
        // Subscribe to the judge's turn-end BEFORE prompting so we never miss it.
        const ended = new Promise<"ended" | "timeout">(resolveEnd => {
          const unsubs: Array<() => void> = []
          let done = false
          const finish = (r: "ended" | "timeout") => {
            if (done) return
            done = true
            clearTimeout(timer)
            for (const u of unsubs) u()
            resolveEnd(r)
          }
          const timer = setTimeout(() => finish("timeout"), timeoutMs)
          const onEnd = (ev: { sessionId: string }) => {
            if (ev.sessionId === judgeId) finish("ended")
          }
          unsubs.push(sessionEvents.on("session:turn-end", onEnd))
          unsubs.push(sessionEvents.on("session:awaiting-input", onEnd))
          unsubs.push(sessionEvents.on("session:exited", onEnd))
        })

        try {
          await registry.sendPrompt(judgeId, fullPrompt)
        } catch (err) {
          return { passed: false, exitCode: 1, reason: `judge prompt failed: ${err instanceof Error ? err.message : String(err)}` }
        }

        const outcome = await ended
        if (outcome === "timeout") {
          return { passed: false, exitCode: 1, reason: `judge timed out after ${timeoutMs}ms` }
        }

        const reply = readTail(judgeId, 200)
        const verdict = parseVerdict(reply)
        if (verdict === null) {
          return { passed: false, exitCode: 1, reason: "judge reply had no parseable VERDICT line" }
        }
        return verdict === "PASS"
          ? { passed: true, exitCode: 0 }
          : { passed: false, exitCode: 1, reason: "judge verdict: FAIL" }
      } finally {
        // Always kill the judge session — success or failure.
        try {
          registry.kill(judgeId)
        } catch {
          // best-effort
        }
      }
    }

    const runGate = async () => {
      if (entry.cancelled || state.status !== "watching") return
      state.status = "gating"
      schedulePersist()

      if (!input.gate) {
        await act(true, 0)
        return
      }

      // WP7: judge-agent gate.
      if (isJudgeGate(input.gate)) {
        const { passed, exitCode, reason } = await runJudge(input.gate.judge)
        state.lastGate = { exitCode, at: new Date().toISOString() }
        if (!passed && reason) state.error = reason
        schedulePersist()
        await act(passed, exitCode)
        return
      }

      try {
        const allowlist = await loadAllowlist(workspace)
        const baseName = basename(input.gate.command)
        if (!allowlist.has(baseName)) {
          emitFailed(-1, `gate command '${baseName}' not in allowlist`)
          return
        }

        const sessionCwd = registry.get(repr)?.cwd ?? workspace
        const resolvedCwd = anchorCwd(input.gate.cwd ?? sessionCwd)

        const result = await exec({
          command: input.gate.command,
          args: input.gate.args ?? [],
          cwd: resolvedCwd,
          timeoutMs: input.gate.timeoutMs ?? 60_000,
        })

        state.lastGate = {
          exitCode: result.exitCode,
          at: new Date().toISOString(),
        }
        schedulePersist()
        await act(result.exitCode === 0, result.exitCode)
      } catch (err) {
        emitFailed(-1, err instanceof Error ? err.message : String(err))
      }
    }
    entry.runGate = runGate

    /**
     * WP6: gate-entry through the daemon-wide concurrency cap. If a slot is
     * free, run the gate now; otherwise park in `queued` (FIFO) and let
     * pumpQueue() admit this entry when a slot frees. Holds no slot while queued.
     */
    const requestGate = () => {
      if (entry.cancelled || state.status !== "watching") return
      if (countActive() >= cap) {
        state.status = "queued"
        if (!gateQueue.includes(entry)) gateQueue.push(entry)
        schedulePersist()
        return
      }
      void runGate()
    }

    /** Remove a member from the pending set (idempotent); gate once empty. */
    const markMemberDone = (sessionId: string) => {
      if (state.status !== "watching") return
      if (!entry.pending.has(sessionId)) return // idempotent — no double-count
      entry.pending.delete(sessionId)
      syncPending()
      schedulePersist()
      if (entry.pending.size === 0) requestGate()
    }

    // Fan-in: a member's first turn-end removes it from the pending set; the
    // gate runs once the set empties.
    unsubscribes.push(
      sessionEvents.on("session:turn-end", ev => {
        if (!group.includes(ev.sessionId)) return
        markMemberDone(ev.sessionId)
      }),
    )

    // Member exit handling:
    //  - group of 1 (legacy single-session form): a lone watched session that
    //    exits before turn-end has nothing to gate on → cancel (unchanged).
    //  - fan-in group (>1): the exited member is treated as "done" and removed
    //    from the pending set, exactly like a turn-end. If every member exits,
    //    the set empties and the gate runs once.
    unsubscribes.push(
      sessionEvents.on("session:exited", ev => {
        if (!group.includes(ev.sessionId)) return
        if (group.length === 1) {
          if (
            state.status === "watching" ||
            state.status === "gating" ||
            state.status === "nudging"
          ) {
            entry.cancelled = true
            state.status = "cancelled"
            state.endedAt = new Date().toISOString()
            schedulePersist()
            cleanup()
            notifySettled(state.policyId)
          }
          return
        }
        markMemberDone(ev.sessionId)
      }),
    )

    // If the pending set was already empty at arm time (e.g. re-armed after a
    // reload where every still-awaited member had exited), gate immediately.
    if (!entry.cancelled && state.status === "watching" && entry.pending.size === 0) {
      requestGate()
    }
  }

  // ── boot-time reload ─────────────────────────────────────────────

  if (persist) {
    let raw: string
    try {
      raw = readFileSync(persistPath, "utf8")
    } catch {
      raw = ""
    }
    if (raw) {
      let parsed: PolicySnapshot | null = null
      try {
        parsed = JSON.parse(raw) as PolicySnapshot
      } catch {
        // corrupt file — ignore
      }
      if (parsed?.policies) {
        for (const { input, state } of parsed.policies) {
          const isTerminal =
            state.status === "done" ||
            state.status === "blocked" ||
            state.status === "cancelled"

          // Reconstruct the fan-in group + pending set defensively (older
          // snapshots predate sessionIds/pending and carry only sessionId).
          const group =
            state.sessionIds && state.sessionIds.length > 0
              ? Array.from(new Set(state.sessionIds))
              : resolveGroup(input)
          const persistedPending =
            state.pending && state.pending.length >= 0
              ? state.pending
              : [...group]

          // WP5: a commit parked awaiting human ack stays awaiting-ack across a
          // restart — re-armed neither to watching nor to a terminal state. No
          // bus subscription (it's past gating); policy_ack drives it. The
          // commitPlan persisted with it carries the exact paths/message/cwd.
          if (state.status === "awaiting-ack") {
            runs.set(state.policyId, {
              input,
              group,
              pending: new Set(persistedPending),
              state: { ...state, sessionIds: group },
              unsubscribes: [],
              cancelled: false,
            })
            continue
          }

          if (isTerminal) {
            // Keep for history, no re-arm needed.
            const entry: RunEntry = {
              input,
              group,
              pending: new Set(persistedPending),
              state,
              unsubscribes: [],
              cancelled: true,
            }
            runs.set(state.policyId, entry)
            continue
          }

          // Active state at crash time. A member still counts as alive only if
          // the registry still reports it running/starting.
          const isAlive = (id: string): boolean => {
            const s = registry.get(id)
            return !!s && (s.status === "running" || s.status === "starting")
          }
          const aliveGroup = group.filter(isAlive)

          if (aliveGroup.length === 0) {
            // No member survived the restart — cancel instead of hanging.
            const cancelledState: PolicyRunState = {
              ...state,
              sessionIds: group,
              pending: [],
              status: "cancelled",
              endedAt: state.endedAt ?? new Date().toISOString(),
              error: "session absent at reload",
            }
            runs.set(state.policyId, {
              input,
              group,
              pending: new Set(),
              state: cancelledState,
              unsubscribes: [],
              cancelled: true,
            })
            continue
          }

          // Re-arm to watching. Re-subscribe only to members still awaited AND
          // still alive: a pending member that died while the daemon was down
          // counts as "done" (same rule as a live exit), so it drops out of the
          // pending set rather than wedging the fan-in forever.
          const rearmedPending = persistedPending.filter(
            id => group.includes(id) && isAlive(id),
          )
          const rearmedState: PolicyRunState = {
            ...state,
            sessionIds: group,
            pending: rearmedPending,
            status: "watching",
          }
          const entry: RunEntry = {
            input,
            group,
            pending: new Set(rearmedPending),
            state: rearmedState,
            unsubscribes: [],
            cancelled: false,
          }
          runs.set(state.policyId, entry)
          armEntry(entry)
        }
      }
    }
  }

  // ── attach core (shared by public attach() + WP6 chaining) ───────

  /**
   * Validate + register + arm a fresh policy. Used both by the public
   * `attach()` and by `maybeChain()` when a parent policy reaches `done`.
   * Hoisted (function declaration) so maybeChain can reference it.
   */
  function attachPolicy(input: AttachPolicyInput): PolicyRunState {
    const group = resolveGroup(input)
    if (input.gate && isJudgeGate(input.gate)) {
      const j = input.gate.judge
      if (typeof j.adapter !== "string" || j.adapter.length === 0) {
        throw new Error("judge gate requires a non-empty adapter")
      }
      if (typeof j.prompt !== "string" || j.prompt.length === 0) {
        throw new Error("judge gate requires a non-empty prompt")
      }
    }
    if (input.then === "commit") {
      if (!input.commit) {
        throw new Error('then:"commit" requires a commit spec')
      }
      if (!Array.isArray(input.commit.paths) || input.commit.paths.length === 0) {
        throw new Error('then:"commit" requires a non-empty paths[]')
      }
      if (input.commit.paths.some(p => typeof p !== "string" || p.length === 0)) {
        throw new Error("commit paths must be non-empty strings")
      }
      if (typeof input.commit.message !== "string" || input.commit.message.length === 0) {
        throw new Error('then:"commit" requires a non-empty message')
      }
    }
    const policyId = `policy_${randomUUID().slice(0, 8)}`
    const state: PolicyRunState = {
      policyId,
      sessionId: group[0]!,
      sessionIds: group,
      pending: [...group],
      status: "watching",
      retries: 0,
      startedAt: new Date().toISOString(),
    }
    const entry: RunEntry = {
      input,
      group,
      pending: new Set(group),
      state,
      unsubscribes: [],
      cancelled: false,
    }
    runs.set(policyId, entry)
    schedulePersist()
    armEntry(entry)
    return state
  }

  // ── public interface ─────────────────────────────────────────────

  return {
    attach(input) {
      return attachPolicy(input)
    },

    getStatus(policyId) {
      return runs.get(policyId)?.state
    },

    cancel(policyId) {
      const entry = runs.get(policyId)
      if (!entry) return
      entry.cancelled = true
      if (
        entry.state.status === "watching" ||
        entry.state.status === "queued" ||
        entry.state.status === "gating" ||
        entry.state.status === "nudging"
      ) {
        const wasActive =
          entry.state.status === "gating" || entry.state.status === "queued"
        entry.state.status = "cancelled"
        entry.state.endedAt = new Date().toISOString()
        for (const u of entry.unsubscribes) u()
        entry.unsubscribes.length = 0
        // WP6: drop from the gate queue and release any held slot.
        const qi = gateQueue.indexOf(entry)
        if (qi >= 0) gateQueue.splice(qi, 1)
        schedulePersist()
        if (wasActive) pumpQueue()
        notifySettled(policyId)
      }
    },

    async ack(policyId, approve) {
      const entry = runs.get(policyId)
      if (!entry) return undefined
      // Only meaningful while parked awaiting a human ack.
      if (entry.state.status !== "awaiting-ack") return entry.state

      if (!approve) {
        entry.cancelled = true
        entry.state.status = "cancelled"
        entry.state.endedAt = new Date().toISOString()
        schedulePersist()
        notifySettled(policyId)
        return entry.state
      }

      await finishCommit(entry)
      notifySettled(policyId)
      return entry.state
    },

    list() {
      return Array.from(runs.values()).map(e => e.state)
    },

    onSettle(cb) {
      settleListeners.add(cb)
      return () => {
        settleListeners.delete(cb)
      }
    },

    shutdown() {
      if (shutdownDone) return
      shutdownDone = true
      if (persistTimer) {
        clearTimeout(persistTimer)
        persistTimer = null
      }
      if (!persist) return
      try {
        const snap = buildSnapshot()
        mkdirSync(dirname(persistPath), { recursive: true })
        writeFileSync(persistPath, JSON.stringify(snap, null, 2) + "\n")
      } catch {
        // best-effort
      }
    },
  }
}
