/**
 * Daemon-native cron scheduler — persisted, survives restarts,
 * fires shell-command, agent-spawn, or session-reprompt jobs on a
 * 5-field cron schedule.
 *
 * Design decisions (see PLAN.md for rationale):
 *
 * ONE TICK LOOP (not one setInterval per job): a single 20-second interval
 * scans all active jobs, fires any whose `nextRunAt` has passed, recomputes
 * `nextRunAt`, and deactivates one-shot jobs after firing. Avoids timer
 * leaks/drift as jobs accumulate.
 *
 * COMMAND ALLOWLIST: `command` action jobs go through the same
 * `loadAllowlist` / basename check that `command_execute` uses — one
 * enforcement path, not two.
 *
 * SKIPPED FIRES: if the daemon was down past a fire time, the skipped
 * executions are NOT backfilled. Recurring jobs resume from "now";
 * one-shot jobs that were missed while the daemon was down are fired
 * immediately on the next tick after restart.
 *
 * PERSISTENCE: `~/.agentproto/cron-jobs.json` and its `.runs.json` ledger,
 * each saved by atomic write-tmp+rename. The ledger retains the last 50
 * completed fires per job. `nextRunAt` is recomputed from now on load when
 * a past fire time is detected.
 *
 * OUTCOME + HEALTH: an agent-spawning action is no longer judged at spawn.
 * After the spawn, the scheduler follows the session's FIRST turn via the
 * injected `observeTurn` (production: `cron-turn-observer.ts`, over
 * `monitorSessionWait`) and records a real `outcome` (`produced` / `empty` /
 * `errored` / `timeout`) with output tokens and duration. N consecutive
 * non-productive runs (default 2, per-job `maxConsecutiveFailures`) pause the
 * job with a `pausedReason`. The spawn lease is released before the
 * observation; a separate `observing` lease stops a re-fire while a previous
 * run is still being followed.
 *
 * EVENTS: `cron:fired`, `cron:succeeded`, `cron:failed`, `cron:unhealthy`
 * emitted on the shared SessionEventBus so outcomes are visible via
 * session_events_poll / session_monitor — no separate notification path.
 */

import { randomUUID } from "node:crypto"
import { homedir } from "node:os"
import { join, dirname, basename } from "node:path"
import {
  mkdirSync,
  readFileSync,
  existsSync,
  writeFileSync,
  renameSync,
} from "node:fs"
import { Cron } from "croner"
import { loadAllowlist, runCommand } from "./command-tools.js"
import { SESSION_ID_ENV, WORKSPACE_SLUG_ENV, mintSessionId, type SessionsRegistry } from "./sessions.js"
import type { SessionEventBus } from "./session-event-bus.js"
import type { AgentAdapterLister, AgentAdapterResolver } from "./http-server.js"
import { restartAgentSession } from "./session-restart-core.js"
import { authProfileAsAdapterHint, type AuthProfileLookup } from "./adapter-slug-hint.js"
import { toAgentStartCall, type DetachedAgentStartInput } from "./agent-start-schema.js"

// ── Public types ─────────────────────────────────────────────────────

export type CronAction =
  | {
      kind: "command"
      command: string
      args?: string[]
      cwd?: string
      timeoutMs?: number
    }
  | ({
      // Every `agent_start` field (minus `wait`) — one shared schema, see
      // agent-start-schema.ts. Fired by lowering to an `agent_start` call,
      // so a field added there works here with no extra code. Jobs persisted
      // before this carried only adapter/prompt/cwd/model/mode/
      // permissionHold/options, all still part of the shape.
      kind: "agent"
    } & DetachedAgentStartInput)
  | {
      kind: "prompt-session"
      sessionId: string
      prompt: string
    }
  | {
      // Universal escape hatch: calls ANY daemon MCP tool by name, in-process
      // (see `dispatchTool` below). This is what powers AIP-41 routine
      // `target.tool` (+ the `agent`/`workflow` sugar, which lower to this
      // same kind before reaching the scheduler) — see
      // packages/routine/README.md "Runtime bridge" section.
      kind: "tool"
      /** Registered MCP tool name, e.g. "worktree_gc", "agent_start". */
      tool: string
      inputs?: Record<string, unknown>
    }

/**
 * True for a tool a `kind:"tool"` job must never dispatch: the cron verbs
 * themselves. A job that creates/runs/deletes cron jobs is self-scheduling —
 * one tick can fan out into unbounded persisted jobs — so it's refused at
 * create time AND at fire time (a hand-edited cron-jobs.json can't sneak one in).
 */
export function isSelfSchedulingTool(tool: string): boolean {
  return tool.startsWith("cron_")
}

/** Throws when `action` is one the scheduler refuses to hold. */
export function assertCronActionAllowed(action: CronAction): void {
  if (action.kind === "tool" && isSelfSchedulingTool(action.tool)) {
    throw new Error(
      `cron action kind "tool" cannot dispatch '${action.tool}': cron jobs may not schedule cron_* tools (self-scheduling)`,
    )
  }
}

/**
 * The host adapter slug an agent-spawning action will resolve when it fires,
 * or undefined when there's nothing to check up front: no explicit
 * `adapter`/`harness` (a `presetId` supplies it), or a `sandbox` spawn (the
 * box resolves its own adapter). Covers both the native `kind:"agent"` shape
 * and `kind:"tool"` → `agent_start` (what a routine's `target.agent` lowers to).
 */
function hostAdapterSlugOf(action: CronAction): string | undefined {
  const fields: Record<string, unknown> | undefined =
    action.kind === "agent"
      ? action
      : action.kind === "tool" && action.tool === "agent_start"
        ? action.inputs
        : undefined
  if (!fields || fields.sandbox !== undefined) return undefined
  const slug = fields.adapter ?? fields.harness
  return typeof slug === "string" && slug.length > 0 ? slug : undefined
}

export interface CronAdapterCheckDeps {
  resolveAgentAdapter?: AgentAdapterResolver
  /** Auth-profile lookup by id — only used to word the error when the slug is a profile id. */
  getAuthProfile?: AuthProfileLookup
  /** Installed-adapter lister — only used to list valid slugs in the error. */
  listAgentAdapters?: AgentAdapterLister
}

/**
 * Throws when an agent-spawning `action` names a host adapter that doesn't
 * resolve — so a job that can only ever fail at fire time is refused at
 * create time instead. No-op when there's no resolver wired, no explicit
 * adapter, or the spawn is sandboxed. Never applied to jobs rehydrated from
 * disk: those keep loading and fail at fire time as before.
 */
export async function assertCronAdapterResolvable(
  action: CronAction,
  deps: CronAdapterCheckDeps,
): Promise<void> {
  const slug = hostAdapterSlugOf(action)
  if (!slug || !deps.resolveAgentAdapter) return
  // `resolveAgentAdapter` collapses failures to null by contract; guard a throw anyway.
  const resolved = await deps.resolveAgentAdapter(slug).catch(() => null)
  if (resolved) return

  let hint = await authProfileAsAdapterHint(slug, deps.getAuthProfile)
  if (!hint) {
    const installed = await deps.listAgentAdapters?.().catch(() => undefined)
    if (installed && installed.length > 0) {
      hint = `Installed adapters: ${installed.map(a => a.slug).sort().join(", ")}.`
    } else {
      hint = `If it has never been installed, run \`agentproto install ${slug}\` first.`
    }
  }
  throw new Error(
    `cron action adapter '${slug}' could not be resolved — refusing to create a job ` +
      `that would fail at fire time. ${hint}`,
  )
}

export interface CronJob {
  id: string
  label?: string
  /** 5-field cron expression in local time (minute hour day-of-month month day-of-week). */
  schedule: string
  /** IANA tz database name the schedule is interpreted in. Defaults to host local time. */
  timezone?: string
  /** When false, the job fires once then deactivates (one-shot). Default true. */
  recurring: boolean
  action: CronAction
  createdAt: string
  /** When false, the job will not fire. */
  active: boolean
  /** A one-shot job has fired and will not fire again unless explicitly resumed. */
  finished?: boolean
  nextRunAt?: string
  lastRunAt?: string
  lastResult?: { ok: boolean; summary: string }
  /**
   * Real outcome of the LAST completed run (see {@link CronRunOutcome}),
   * maintained alongside the ledger so `cron_list` can report health without
   * reading run history. Absent on jobs created before this field existed.
   */
  lastOutcome?: CronRunOutcome
  /**
   * Consecutive non-productive runs since the last `produced` one. Reset to 0
   * by a produced run (and on an explicit resume). Absent means 0.
   */
  consecutiveFailures?: number
  /**
   * Set when the health check auto-paused the job; cleared when an operator
   * resumes it. Free-text so the reason survives a daemon restart.
   */
  pausedReason?: string
  /**
   * Health threshold: pause after this many consecutive non-productive runs.
   * Defaults to {@link DEFAULT_MAX_CONSECUTIVE_FAILURES} (2).
   */
  maxConsecutiveFailures?: number
  /**
   * Per-job bound (ms) on how long to follow a spawned session's first turn
   * before recording `timeout`. Defaults to the scheduler's
   * `observeTimeoutMs` (30 min).
   */
  runTimeoutMs?: number
}

/** Real outcome of a single cron run, as recorded in the ledger. */
export type CronRunOutcome = "produced" | "empty" | "errored" | "timeout"

export interface CronRun {
  runId: string
  jobId: string
  startedAt: string
  endedAt: string
  ok: boolean
  sessionId?: string
  result: string
  error?: string
  /**
   * Real outcome, when the run was observed to completion (or classified from
   * a known action status). Optional so ledger entries written before this
   * field existed still parse.
   */
  outcome?: CronRunOutcome
  /** Output tokens the spawned session produced, when reported. */
  tokensOut?: number
  /** Wall-clock duration of the observed run, when known. */
  durationMs?: number
}

export interface CronUpdate {
  label?: string | null
  schedule?: string
  timezone?: string | null
  recurring?: boolean
  active?: boolean
  action?: CronAction
  maxConsecutiveFailures?: number
  runTimeoutMs?: number
}

export interface CronRunsPage {
  runs: CronRun[]
  nextCursor?: string
}

/**
 * What an observed session's first turn produced. Mirrors the values stored
 * in `CronRun.outcome` / `CronJob.lastOutcome`.
 */
export interface CronTurnObservation {
  outcome: CronRunOutcome
  /** Output tokens the session reported for the turn, when known. */
  tokensOut?: number
  /** The adapter's turn-end `reason` (e.g. `"error"`), when reported. */
  reason?: string
  /** Captured in-band error text, when the turn errored. */
  error?: string
  /** Wall-clock duration of the observed turn, when known. */
  durationMs?: number
}

/**
 * Follows a cron-spawned session until its FIRST turn ends (or a bound
 * elapses) and reports the real outcome. Injected into the scheduler so the
 * turn-end / token-usage observation is unit-testable: production wires a
 * `monitorSessionWait`-backed implementation (`cron-turn-observer.ts`),
 * tests pass a stub.
 */
export type CronTurnObserver = (input: {
  sessionId: string
  jobId: string
  /** Hard bound on the wait — the run records `timeout` past it. */
  timeoutMs: number
}) => Promise<CronTurnObservation>

/** Health view surfaced by `cron_list`. */
export interface CronJobHealth {
  lastOutcome?: CronRunOutcome
  consecutiveFailures: number
  pausedReason?: string
  maxConsecutiveFailures: number
}

/** Pause after this many consecutive non-productive runs unless a job overrides it. */
export const DEFAULT_MAX_CONSECUTIVE_FAILURES = 2

/** Default bound on following a spawned session's first turn (30 min). */
export const DEFAULT_OBSERVE_TIMEOUT_MS = 30 * 60_000

/** Project a job's health for `cron_list` / callers that don't read the ledger. */
export function cronJobHealth(job: CronJob): CronJobHealth {
  return {
    ...(job.lastOutcome ? { lastOutcome: job.lastOutcome } : {}),
    consecutiveFailures: job.consecutiveFailures ?? 0,
    ...(job.pausedReason ? { pausedReason: job.pausedReason } : {}),
    maxConsecutiveFailures: job.maxConsecutiveFailures ?? DEFAULT_MAX_CONSECUTIVE_FAILURES,
  }
}

export interface CronScheduler {
  /**
   * Create and persist a new cron job. Validates the schedule expression and,
   * for an agent-spawning action, that its host adapter resolves
   * (`assertCronAdapterResolvable`) — rejects if either is invalid. Returns
   * the created job.
   */
  create(input: {
    label?: string
    schedule: string
    /** IANA tz database name. Defaults to host local time when omitted. */
    timezone?: string
    recurring?: boolean
    action: CronAction
    maxConsecutiveFailures?: number
    runTimeoutMs?: number
  }): Promise<CronJob>

  list(): CronJob[]
  get(id: string): CronJob | undefined
  update(id: string, patch: CronUpdate): Promise<CronJob>
  runs(input?: { jobId?: string; limit?: number; cursor?: string }): CronRunsPage

  /**
   * Permanently remove a job. Throws if not found.
   */
  delete(id: string): void

  /**
   * Manually fire a job immediately, bypassing its schedule.
   * Returns the job's lastResult once the action completes.
   */
  run(id: string): Promise<CronJob["lastResult"]>

  /** Clean up: stop the tick interval. */
  shutdown(): void
}

// ── Internal state ───────────────────────────────────────────────────

interface JobState {
  job: CronJob
  /** Live croner instance — kept for nextDate() queries and released when deleted. */
  cronInstance?: Cron
  /**
   * In-memory execution lease. A slow action must not be re-fired by the
   * 20-second tick while its `nextRunAt` still points at the elapsed slot.
   * Deliberately not persisted: after a daemon restart, the normal stale-slot
   * rehydration advances `nextRunAt` to the next scheduled occurrence.
   */
  running?: boolean
  /**
   * Set while a spawned session's first turn is being followed. Distinct from
   * `running`: the spawn lease is released as soon as the action returns so
   * the tick/`update()` aren't blocked for the (up to 30 min) observation —
   * but a job must not re-fire while its previous run is still being
   * observed, so the tick checks this too. Not persisted: an in-flight
   * observation dies with the daemon.
   */
  observing?: boolean
}

// ── Factory ──────────────────────────────────────────────────────────

const DEFAULT_PERSIST_PATH = (): string =>
  join(homedir(), ".agentproto", "cron-jobs.json")

const TICK_INTERVAL_MS = 20_000
const MAX_RUNS_PER_JOB = 50

function ledgerPath(persistPath: string): string {
  return `${persistPath}.runs.json`
}

function loadRuns(path: string): Map<string, CronRun[]> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"))
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return new Map()
    const runs = new Map<string, CronRun[]>()
    for (const [jobId, value] of Object.entries(parsed)) {
      if (Array.isArray(value)) {
        runs.set(jobId, value.filter((run): run is CronRun =>
          run && typeof run.runId === "string" && run.jobId === jobId &&
          typeof run.startedAt === "string" && typeof run.endedAt === "string" &&
          typeof run.ok === "boolean" && typeof run.result === "string",
        ).slice(-MAX_RUNS_PER_JOB))
      }
    }
    return runs
  } catch {
    return new Map()
  }
}

function saveRuns(runs: Map<string, CronRun[]>, path: string): void {
  try {
    mkdirSync(dirname(path), { recursive: true })
    const tmp = `${path}.tmp.${process.pid}`
    writeFileSync(tmp, JSON.stringify(Object.fromEntries(runs), null, 2) + "\n", "utf8")
    renameSync(tmp, path)
  } catch {
    // Match job persistence: a disk failure must not crash the daemon.
  }
}

// ── Persistence helpers ──────────────────────────────────────────────

function loadJobs(persistPath: string): Map<string, JobState> {
  const result = new Map<string, JobState>()
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
    // Malformed — start empty (documented: not an error).
    return result
  }
  if (!Array.isArray(parsed)) return result
  for (const item of parsed) {
    if (
      !item ||
      typeof item !== "object" ||
      typeof (item as CronJob).id !== "string" ||
      typeof (item as CronJob).schedule !== "string"
    )
      continue
    const job = item as CronJob
    // Ensure required fields have defaults for forward-compat.
    job.recurring = job.recurring ?? true
    job.active = job.active ?? true
    if (job.finished === undefined && !job.recurring && !job.active && !!job.lastRunAt) {
      job.finished = true
    }
    result.set(job.id, { job })
  }
  return result
}

function saveJobs(jobs: Map<string, JobState>, persistPath: string): void {
  try {
    mkdirSync(dirname(persistPath), { recursive: true })
    const payload =
      JSON.stringify(
        Array.from(jobs.values()).map(s => s.job),
        null,
        2,
      ) + "\n"
    const tmp = `${persistPath}.tmp.${process.pid}`
    writeFileSync(tmp, payload, "utf8")
    renameSync(tmp, persistPath)
  } catch {
    // Best-effort — a write failure must not crash the daemon.
  }
}

// ── Croner helpers ───────────────────────────────────────────────────

/**
 * Parse a 5-field cron expression and return a dormant Cron instance
 * (not scheduled — we drive ticks manually for the one-loop pattern).
 * Throws `SyntaxError` if the expression is invalid.
 */
function parseCron(schedule: string, timezone?: string): Cron {
  // Validate by constructing a paused instance.
  // croner throws `SyntaxError` for bad patterns.
  return new Cron(schedule, { paused: true, ...(timezone ? { timezone } : {}) })
}

/** Renders a CallToolResult-shaped value (or anything else) to {ok, summary}. */
function summarizeToolResult(result: unknown): { ok: boolean; summary: string } {
  if (result && typeof result === "object" && "content" in result) {
    const r = result as { content?: Array<{ type?: string; text?: string }>; isError?: boolean }
    const text = (r.content ?? [])
      .map(c => c.text ?? "")
      .join("\n")
      .trim()
    return { ok: !r.isError, summary: text || (r.isError ? "tool call failed" : "ok") }
  }
  return { ok: true, summary: JSON.stringify(result ?? null) }
}

function nextFireDate(cronInstance: Cron): Date | null {
  return cronInstance.nextRun() ?? null
}

// ── Factory function ─────────────────────────────────────────────────

export function createCronScheduler(opts: {
  sessionEvents: SessionEventBus
  registry: SessionsRegistry
  resolveAgentAdapter?: AgentAdapterResolver
  /**
   * In-process caller for ANY registered daemon MCP tool by name — powers
   * `kind:"tool"` actions. See `dispatchTool` in `index.ts` (reaches into
   * an internal `McpServer`'s `_registeredTools` map; same cast as
   * `__tests__/tool-subset.test.ts`). Omitted → `kind:"tool"` jobs fail
   * clearly at fire time rather than silently no-op'ing.
   */
  dispatchTool?: (name: string, inputs: Record<string, unknown>) => Promise<unknown>
  /** Wording-only helpers for the create-time adapter check — see `assertCronAdapterResolvable`. */
  getAuthProfile?: CronAdapterCheckDeps["getAuthProfile"]
  listAgentAdapters?: AgentAdapterLister
  /** Workspace dir — used for the command allowlist. */
  workspace: string
  /** Absolute path for the persistence file. Defaults to ~/.agentproto/cron-jobs.json */
  persistPath?: string
  /**
   * Enable filesystem persistence. Defaults to `true` when `persistPath` is
   * explicitly supplied, `false` otherwise. Production code passes persist:true.
   */
  persist?: boolean
  /**
   * Follow a spawned session's first turn to a real outcome. Omitted → a
   * successful spawn is recorded as `produced` (the pre-health-check
   * behaviour), which keeps unit tests and any caller that doesn't wire the
   * daemon's turn observer working unchanged.
   */
  observeTurn?: CronTurnObserver
  /** Default bound (ms) on the turn observation. Defaults to 30 min. */
  observeTimeoutMs?: number
}): CronScheduler {
  const { sessionEvents, registry, resolveAgentAdapter, dispatchTool, workspace } = opts
  const observeTurn = opts.observeTurn
  const observeTimeoutMs = opts.observeTimeoutMs ?? DEFAULT_OBSERVE_TIMEOUT_MS
  const persistPath = opts.persistPath ?? DEFAULT_PERSIST_PATH()
  const shouldPersist = opts.persist ?? (opts.persistPath !== undefined)

  const jobs = shouldPersist ? loadJobs(persistPath) : new Map<string, JobState>()
  const runHistory = shouldPersist ? loadRuns(ledgerPath(persistPath)) : new Map<string, CronRun[]>()
  const appendRun = (run: CronRun): void => {
    const history = runHistory.get(run.jobId) ?? []
    history.push(run)
    if (history.length > MAX_RUNS_PER_JOB) history.splice(0, history.length - MAX_RUNS_PER_JOB)
    runHistory.set(run.jobId, history)
    if (shouldPersist) saveRuns(runHistory, ledgerPath(persistPath))
  }

  // Rehydrate cronInstance for every loaded job and recompute nextRunAt if stale.
  for (const state of jobs.values()) {
    if (!state.job.active) continue
    try {
      const inst = parseCron(state.job.schedule, state.job.timezone)
      state.cronInstance = inst
      // If the stored nextRunAt is in the past (daemon was down), recompute
      // from the cron schedule — this gives the next scheduled occurrence
      // *after now*, not an immediate fire. Skipped executions during
      // downtime are intentionally not backfilled (documented behaviour).
      const storedNext = state.job.nextRunAt ? new Date(state.job.nextRunAt) : null
      if (!storedNext || storedNext <= new Date()) {
        const next = nextFireDate(inst)
        state.job.nextRunAt = next?.toISOString()
      }
    } catch {
      // Bad stored schedule — deactivate the job so it doesn't block boot.
      state.job.active = false
    }
  }
  if (shouldPersist) saveJobs(jobs, persistPath)

  const persistNow = (): void => {
    if (shouldPersist) saveJobs(jobs, persistPath)
  }

  // ── Action executor ───────────────────────────────────────────────

  const executeAction = async (job: CronJob): Promise<{ ok: boolean; summary: string; sessionId?: string }> => {
    const action = job.action

    if (action.kind === "command") {
      const allowlist = await loadAllowlist(workspace)
      const baseName = basename(action.command)
      if (!allowlist.has(baseName)) {
        const allowed = [...allowlist].sort().join(", ") || "(empty)"
        throw new Error(
          `cron job '${job.id}': command '${baseName}' is not in the allowlist. ` +
            `Add it to ${workspace}/.agentproto/allowed-commands.json. Currently allowed: ${allowed}.`,
        )
      }
      const cwd = action.cwd ?? workspace
      // Minted BEFORE the spawn — same rule as command_execute
      // (command-tools.ts) — so it can be injected as AGENTPROTO_SESSION_ID
      // into the command's own env and re-used (not re-minted) below.
      const commandSessionId = mintSessionId()
      const result = await runCommand({
        command: action.command,
        args: action.args ?? [],
        cwd,
        timeoutMs: action.timeoutMs ?? 60_000,
        env: {
          [SESSION_ID_ENV]: commandSessionId,
          [WORKSPACE_SLUG_ENV]: "default",
        },
      })
      // Same session-based record as command_execute — cron "command" jobs
      // already share its allowlist + runCommand ("one enforcement path,
      // not two"), so they share its `kind:"command"` audit trail too:
      // the fired job gets its own session row in command_list/session_list,
      // not just a line in `job.lastResult`.
      registry.recordCommand({
        id: commandSessionId,
        workspaceSlug: "default",
        cwd,
        command: action.command,
        args: action.args ?? [],
        exitCode: result.exitCode,
        signal: result.signal,
        durationMs: result.durationMs,
        stdout: result.stdout,
        stderr: result.stderr,
        ...(result.truncated ? { truncated: true } : {}),
        label: `cron:${job.id}`,
        // Same origin the agent-action branch below already stamps. No
        // `callerSessionId`: a cron tick is a daemon timer callback, not
        // itself a SessionDescriptor — there's no real session id to
        // attribute this to, and `job.id` (already in `label`) isn't one.
        origin: "cron",
      })
      if (result.exitCode !== 0) {
        throw new Error(
          `command exited with code ${result.exitCode}: ${result.stderr.trim() || result.stdout.trim() || "(no output)"}`,
        )
      }
      const summary = result.stdout.trim() || `exit 0 (${result.durationMs}ms)`
      return { ok: true, summary }
    }

    if (action.kind === "prompt-session") {
      const desc = registry.get(action.sessionId)
      if (!desc) {
        throw new Error(
          `cron job '${job.id}': session '${action.sessionId}' not found`,
        )
      }
      if (desc.processAlive === false) {
        if (!resolveAgentAdapter) {
          throw new Error(
            `cron job '${job.id}': session '${action.sessionId}' is not alive and agent ` +
              "restart is not enabled (no resolveAgentAdapter)",
          )
        }
        const restarted = await restartAgentSession(
          registry,
          resolveAgentAdapter,
          desc,
          // A cron `prompt-session` job needs `sendPrompt` on the
          // result, which only an agent-cli session has — never let
          // decideRestartStrategy hand back a PTY-native resume (e.g.
          // claude-code's `claude --resume`) here.
          { forceAgentResume: true },
        )
        action.sessionId = restarted.desc.id
        await registry.sendPrompt(restarted.desc.id, action.prompt)
        return {
          ok: true,
          summary:
            `session '${desc.id}' was gone — resumed as '${restarted.desc.id}' ` +
            `(${restarted.resumeVia || "fresh spawn, no continuity"}) and re-prompted`,
        }
      }
      if (desc.busy) {
        return {
          ok: true,
          summary: `session ${action.sessionId} busy (mid-turn), tick skipped`,
        }
      }
      // Same underlying call as the agent_prompt MCP tool / POST
      // /sessions/:id/prompt — re-prompts the existing session in place
      // rather than spawning a new one.
      await registry.sendPrompt(action.sessionId, action.prompt)
      return {
        ok: true,
        summary: `re-prompted session ${action.sessionId}`,
      }
    }

    if (action.kind === "tool") {
      if (!dispatchTool) {
        throw new Error(
          `cron job '${job.id}': tool action requires dispatchTool to be wired`,
        )
      }
      assertCronActionAllowed(action)
      const result = await dispatchTool(action.tool, action.inputs ?? {})
      const { ok, summary } = summarizeToolResult(result)
      if (!ok) {
        throw new Error(`cron job '${job.id}': tool '${action.tool}' failed: ${summary}`)
      }
      let sessionId: string | undefined
      if (action.tool === "agent_start") {
        try {
          const body = JSON.parse(summary) as { id?: unknown }
          if (typeof body.id === "string") sessionId = body.id
        } catch { /* The tool result may be plain text. */ }
      }
      return { ok: true, summary: `tool '${action.tool}': ${summary}`, sessionId }
    }

    // action.kind === "agent" — lowered to the real `agent_start` handler
    // (auth profile, role, worktree, dedupe, validation) exactly like a live
    // call, rather than a parallel spawn path here.
    if (!dispatchTool) {
      throw new Error(
        `cron job '${job.id}': agent action requires dispatchTool to be wired`,
      )
    }
    const { kind: _kind, ...fields } = action
    // Same default cwd the scheduler has always used, unless the job names
    // its own location (cwd, workspaceSlug, or a preset that may pin one).
    if (!fields.cwd && !fields.workspaceSlug && !fields.presetId) fields.cwd = workspace
    const call = toAgentStartCall(fields, { origin: `cron:${job.id}`, context: `cron job '${job.id}'` })
    const result = await dispatchTool(call.tool, call.inputs)
    const { ok, summary } = summarizeToolResult(result)
    if (!ok) {
      throw new Error(`cron job '${job.id}': agent_start failed: ${summary}`)
    }
    let sessionId: string | undefined
    try {
      const body = JSON.parse(summary) as { id?: unknown }
      if (typeof body.id === "string") sessionId = body.id
    } catch {
      // Non-JSON body — fall through to the raw summary.
    }
    return {
      ok: true,
      sessionId,
      summary: sessionId
        ? `spawned session ${sessionId} (adapter=${action.adapter ?? action.harness ?? "preset"})`
        : `agent_start: ${summary}`,
    }
  }

  // ── Fire a job ────────────────────────────────────────────────────

  /** Metrics suffix for a run summary, e.g. " (120 output tokens, 4210ms)". */
  const metricsSuffix = (obs: CronTurnObservation, includeTokens: boolean): string => {
    const parts: string[] = []
    if (includeTokens && obs.tokensOut !== undefined) parts.push(`${obs.tokensOut} output tokens`)
    if (obs.durationMs !== undefined) parts.push(`${obs.durationMs}ms`)
    return parts.length > 0 ? ` (${parts.join(", ")})` : ""
  }

  /** Human-readable summary for a completed run's real outcome. */
  const summarizeOutcome = (
    outcome: CronRunOutcome,
    obs: CronTurnObservation,
    sessionId: string | undefined,
    fallback?: string,
  ): string => {
    const who = sessionId ? `session ${sessionId}` : "run"
    switch (outcome) {
      case "produced":
        return fallback ?? `${who} produced output${metricsSuffix(obs, true)}`
      case "empty":
        return `empty: ${who} produced no output${metricsSuffix(obs, true)}`
      case "timeout":
        return `timeout: ${who} did not finish its first turn within ${obs.durationMs ?? observeTimeoutMs}ms`
      case "errored":
        return `errored: ${who} ${obs.error ?? obs.reason ?? "turn failed"}`
    }
  }

  /**
   * Record a finished run in the ledger, emit its outcome event, and apply the
   * health check (consecutive-failure counter → auto-pause + `cron:unhealthy`).
   * One place for both the observed and unobserved paths.
   */
  const finalizeRun = (
    state: JobState,
    startedAt: string,
    endedAt: string,
    obs: CronTurnObservation,
    sessionId: string | undefined,
    spawnError: string | undefined,
    fallbackSummary?: string,
  ): void => {
    const { job } = state
    const outcome = obs.outcome
    const productive = outcome === "produced"
    const summary = summarizeOutcome(outcome, obs, sessionId, productive ? fallbackSummary : undefined)
    const runError = outcome === "errored" ? (obs.error ?? spawnError ?? summary) : undefined
    appendRun({
      runId: `run_${randomUUID()}`,
      jobId: job.id,
      startedAt,
      endedAt,
      ok: productive,
      ...(sessionId ? { sessionId } : {}),
      result: summary,
      outcome,
      ...(obs.tokensOut !== undefined ? { tokensOut: obs.tokensOut } : {}),
      ...(obs.durationMs !== undefined ? { durationMs: obs.durationMs } : {}),
      ...(runError ? { error: runError } : {}),
    })
    if (productive) {
      sessionEvents.emit({ type: "cron:succeeded", jobId: job.id, label: job.label, summary, ts: endedAt })
    } else {
      sessionEvents.emit({ type: "cron:failed", jobId: job.id, label: job.label, error: runError ?? summary, ts: endedAt })
    }
    job.lastResult = { ok: productive, summary }
    job.lastOutcome = outcome

    const max = job.maxConsecutiveFailures ?? DEFAULT_MAX_CONSECUTIVE_FAILURES
    if (productive) {
      job.consecutiveFailures = 0
    } else {
      job.consecutiveFailures = (job.consecutiveFailures ?? 0) + 1
      if (job.active && job.consecutiveFailures >= max) {
        job.active = false
        job.pausedReason = `auto-paused after ${job.consecutiveFailures} consecutive non-productive runs (last outcome: ${outcome})`
        state.cronInstance?.stop()
        state.cronInstance = undefined
        sessionEvents.emit({
          type: "cron:unhealthy",
          jobId: job.id,
          label: job.label,
          consecutiveFailures: job.consecutiveFailures,
          lastOutcome: outcome,
          reason: job.pausedReason,
          ts: endedAt,
        })
      }
    }
    persistNow()
  }

  const fireJob = async (state: JobState): Promise<void> => {
    // `tick()` intentionally does not await fireJob. Without the spawn lease, a
    // slow agent start leaves nextRunAt in the past and every subsequent tick
    // starts another identical agent before the first one completes. The
    // `observing` lease additionally holds off a re-fire while a previous run
    // is still being followed to its first turn-end.
    if (state.running || state.observing) return
    state.running = true

    const { job } = state
    const startedAt = new Date().toISOString()
    job.lastRunAt = startedAt
    sessionEvents.emit({ type: "cron:fired", jobId: job.id, label: job.label, ts: startedAt })

    let result: { ok: boolean; summary: string; sessionId?: string }
    let error: string | undefined
    try {
      result = await executeAction(job)
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
      result = { ok: false, summary: error }
    } finally {
      // The spawn is done — release the execution lease so neither the tick
      // nor `update()` is held for the (potentially long) observation below.
      state.running = false
    }

    // Advance the schedule / deactivate a one-shot right after the spawn, not
    // after the observation: a 30-min observation must not postpone the next
    // scheduled slot. The `observing` lease is what prevents a re-fire.
    if (!job.recurring) {
      job.active = false
      job.finished = true
      job.nextRunAt = undefined
      state.cronInstance?.stop()
      state.cronInstance = undefined
    } else if (state.cronInstance) {
      const next = nextFireDate(state.cronInstance)
      job.nextRunAt = next?.toISOString()
    }
    persistNow()

    const sessionId = result.sessionId
    if (!error && sessionId && observeTurn) {
      state.observing = true
      let obs: CronTurnObservation
      try {
        obs = await observeTurn({
          sessionId,
          jobId: job.id,
          timeoutMs: job.runTimeoutMs ?? observeTimeoutMs,
        })
      } catch (err) {
        obs = { outcome: "errored", error: err instanceof Error ? err.message : String(err) }
      } finally {
        state.observing = false
      }
      finalizeRun(state, startedAt, new Date().toISOString(), obs, sessionId, error)
      return
    }

    // No observer wired (or nothing to follow): the action's own success or
    // failure is the outcome. A known `failed` status (command non-zero exit,
    // a tool that reported an error) therefore counts as non-productive too.
    const outcome: CronRunOutcome = error ? "errored" : "produced"
    finalizeRun(
      state,
      startedAt,
      new Date().toISOString(),
      { outcome, ...(error ? { error } : {}) },
      sessionId,
      error,
      result.summary,
    )
  }

  // ── Tick loop ─────────────────────────────────────────────────────

  const tick = (): void => {
    const now = new Date()
    for (const state of jobs.values()) {
      if (!state.job.active) continue
      if (!state.job.nextRunAt) continue
      const fireAt = new Date(state.job.nextRunAt)
      if (fireAt <= now) {
        // Fire asynchronously — tick must not block.
        void fireJob(state).catch(() => {
          // fireJob already handles errors internally; this catch covers
          // the rare case where fireJob itself throws synchronously.
        })
      }
    }
  }

  const tickTimer = setInterval(tick, TICK_INTERVAL_MS)
  tickTimer.unref() // don't keep the process alive on its own

  // ── Public interface ──────────────────────────────────────────────

  return {
    async create({ label, schedule, timezone, recurring = true, action, maxConsecutiveFailures, runTimeoutMs }) {
      assertCronActionAllowed(action)
      // Validate schedule — throws SyntaxError if invalid.
      const cronInstance = parseCron(schedule, timezone)
      await assertCronAdapterResolvable(action, {
        resolveAgentAdapter,
        getAuthProfile: opts.getAuthProfile,
        listAgentAdapters: opts.listAgentAdapters,
      })
      const id = `cron_${randomUUID()}`
      const next = nextFireDate(cronInstance)
      const job: CronJob = {
        id,
        ...(label ? { label } : {}),
        schedule,
        ...(timezone ? { timezone } : {}),
        recurring,
        action,
        createdAt: new Date().toISOString(),
        active: true,
        finished: false,
        nextRunAt: next?.toISOString(),
        ...(maxConsecutiveFailures !== undefined ? { maxConsecutiveFailures } : {}),
        ...(runTimeoutMs !== undefined ? { runTimeoutMs } : {}),
      }
      jobs.set(id, { job, cronInstance })
      persistNow()
      return job
    },

    list() {
      return Array.from(jobs.values()).map(s => s.job)
    },

    get(id) {
      return jobs.get(id)?.job
    },

    async update(id, patch) {
      const state = jobs.get(id)
      if (!state) throw new Error(`cron job not found: ${id}`)
      if (state.running) throw new Error(`cron job is running: ${id}`)
      const job = state.job
      const schedule = patch.schedule ?? job.schedule
      const timezone = patch.timezone === null ? undefined : (patch.timezone ?? job.timezone)
      const action = patch.action ?? job.action
      if (!schedule) throw new Error("cron schedule must not be empty")
      assertCronActionAllowed(action)
      const cronInstance = parseCron(schedule, timezone)
      await assertCronAdapterResolvable(action, {
        resolveAgentAdapter,
        getAuthProfile: opts.getAuthProfile,
        listAgentAdapters: opts.listAgentAdapters,
      })
      const active = patch.active ?? job.active
      const next = active ? nextFireDate(cronInstance) : null
      state.cronInstance?.stop()
      state.cronInstance = active ? cronInstance : undefined
      job.schedule = schedule
      job.timezone = timezone
      job.action = action
      job.recurring = patch.recurring ?? job.recurring
      if (patch.label !== undefined) job.label = patch.label === null ? undefined : patch.label
      if (patch.maxConsecutiveFailures !== undefined) job.maxConsecutiveFailures = patch.maxConsecutiveFailures
      if (patch.runTimeoutMs !== undefined) job.runTimeoutMs = patch.runTimeoutMs
      job.active = active
      if (active) {
        job.finished = false
        if (patch.active === true) {
          // An explicit resume clears the auto-pause state so a stale failure
          // counter from before the pause can't immediately re-pause the job.
          job.pausedReason = undefined
          job.consecutiveFailures = 0
        }
      }
      job.nextRunAt = next?.toISOString()
      persistNow()
      return job
    },

    runs({ jobId, limit = 20, cursor }: { jobId?: string; limit?: number; cursor?: string } = {}) {
      if (jobId && !jobs.has(jobId)) throw new Error(`cron job not found: ${jobId}`)
      if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
        throw new Error("limit must be an integer from 1 to 200")
      }
      const all = (jobId
        ? runHistory.get(jobId) ?? []
        : Array.from(runHistory.values()).flat()
      ).slice().sort((a, b) => b.startedAt.localeCompare(a.startedAt) || b.runId.localeCompare(a.runId))
      const start = cursor ? all.findIndex(run => run.runId === cursor) + 1 : 0
      if (cursor && start === 0) throw new Error("invalid cron runs cursor")
      const runs = all.slice(start, start + limit)
      return { runs, ...(start + limit < all.length ? { nextCursor: runs[runs.length - 1]?.runId } : {}) }
    },

    delete(id) {
      const state = jobs.get(id)
      if (!state) throw new Error(`cron job not found: ${id}`)
      state.cronInstance?.stop()
      jobs.delete(id)
      runHistory.delete(id)
      if (shouldPersist) saveRuns(runHistory, ledgerPath(persistPath))
      persistNow()
    },

    async run(id) {
      const state = jobs.get(id)
      if (!state) throw new Error(`cron job not found: ${id}`)
      await fireJob(state)
      return state.job.lastResult
    },

    shutdown() {
      clearInterval(tickTimer)
      for (const state of jobs.values()) {
        state.cronInstance?.stop()
      }
    },
  }
}
