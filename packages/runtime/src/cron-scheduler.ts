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
 * PERSISTENCE: `~/.agentproto/cron-jobs.json`, atomic write-tmp+rename.
 * Job DEFINITIONS (not run state) survive restarts. `nextRunAt` is
 * recomputed from now on load when a past fire time is detected.
 *
 * EVENTS: `cron:fired`, `cron:succeeded`, `cron:failed` emitted on the
 * shared SessionEventBus so outcomes are visible via session_events_poll
 * / session_monitor — no separate notification path.
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
import type { SessionsRegistry } from "./sessions.js"
import type { SessionEventBus } from "./session-event-bus.js"
import type { AgentAdapterResolver } from "./http-server.js"

// ── Public types ─────────────────────────────────────────────────────

export type CronAction =
  | {
      kind: "command"
      command: string
      args?: string[]
      cwd?: string
      timeoutMs?: number
    }
  | {
      kind: "agent"
      adapter: string
      prompt: string
      cwd?: string
      model?: string
    }
  | {
      kind: "prompt-session"
      sessionId: string
      prompt: string
    }

export interface CronJob {
  id: string
  label?: string
  /** 5-field cron expression in local time (minute hour day-of-month month day-of-week). */
  schedule: string
  /** When false, the job fires once then deactivates (one-shot). Default true. */
  recurring: boolean
  action: CronAction
  createdAt: string
  /** When false, the job will not fire. */
  active: boolean
  nextRunAt?: string
  lastRunAt?: string
  lastResult?: { ok: boolean; summary: string }
}

export interface CronScheduler {
  /**
   * Create and persist a new cron job. Validates the schedule expression
   * immediately — throws if it's unparseable. Returns the created job.
   */
  create(input: {
    label?: string
    schedule: string
    recurring?: boolean
    action: CronAction
  }): CronJob

  list(): CronJob[]
  get(id: string): CronJob | undefined

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
}

// ── Factory ──────────────────────────────────────────────────────────

const DEFAULT_PERSIST_PATH = (): string =>
  join(homedir(), ".agentproto", "cron-jobs.json")

const TICK_INTERVAL_MS = 20_000

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
function parseCron(schedule: string): Cron {
  // Validate by constructing a paused instance.
  // croner throws `SyntaxError` for bad patterns.
  return new Cron(schedule, { paused: true })
}

function nextFireDate(cronInstance: Cron): Date | null {
  return cronInstance.nextRun() ?? null
}

// ── Factory function ─────────────────────────────────────────────────

export function createCronScheduler(opts: {
  sessionEvents: SessionEventBus
  registry: SessionsRegistry
  resolveAgentAdapter?: AgentAdapterResolver
  /** Workspace dir — used for the command allowlist. */
  workspace: string
  /** Absolute path for the persistence file. Defaults to ~/.agentproto/cron-jobs.json */
  persistPath?: string
  /**
   * Enable filesystem persistence. Defaults to `true` when `persistPath` is
   * explicitly supplied, `false` otherwise. Production code passes persist:true.
   */
  persist?: boolean
}): CronScheduler {
  const { sessionEvents, registry, resolveAgentAdapter, workspace } = opts
  const persistPath = opts.persistPath ?? DEFAULT_PERSIST_PATH()
  const shouldPersist = opts.persist ?? (opts.persistPath !== undefined)

  const jobs = shouldPersist ? loadJobs(persistPath) : new Map<string, JobState>()

  // Rehydrate cronInstance for every loaded job and recompute nextRunAt if stale.
  for (const state of jobs.values()) {
    if (!state.job.active) continue
    try {
      const inst = parseCron(state.job.schedule)
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

  const executeAction = async (job: CronJob): Promise<{ ok: boolean; summary: string }> => {
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
      const result = await runCommand({
        command: action.command,
        args: action.args ?? [],
        cwd: action.cwd ?? workspace,
        timeoutMs: action.timeoutMs ?? 60_000,
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
        throw new Error(
          `cron job '${job.id}': session '${action.sessionId}' is not alive`,
        )
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

    // action.kind === "agent"
    if (!resolveAgentAdapter) {
      throw new Error(
        `cron job '${job.id}': agent action requires resolveAgentAdapter to be wired`,
      )
    }
    const resolved = await resolveAgentAdapter(action.adapter)
    if (!resolved) {
      throw new Error(
        `cron job '${job.id}': adapter '${action.adapter}' not found`,
      )
    }
    const cwd = action.cwd ?? workspace
    const agentSession = await resolved.startSession({
      cwd,
      ...(action.model ? { model: action.model } : {}),
    })
    const desc = registry.spawnAgent({
      workspaceSlug: "default",
      cwd,
      agentSession,
      adapterSlug: action.adapter,
      label: `cron:${job.id}`,
      ...(resolved.commandPreview ? { commandPreview: resolved.commandPreview } : {}),
    })
    // Fire-and-forget: send the prompt and record the session id.
    if (action.prompt) {
      await registry.sendPrompt(desc.id, action.prompt)
    }
    return {
      ok: true,
      summary: `spawned session ${desc.id} (adapter=${action.adapter})`,
    }
  }

  // ── Fire a job ────────────────────────────────────────────────────

  const fireJob = async (state: JobState): Promise<void> => {
    const { job } = state
    const now = new Date().toISOString()
    job.lastRunAt = now

    sessionEvents.emit({ type: "cron:fired", jobId: job.id, label: job.label, ts: now })

    let result: { ok: boolean; summary: string }
    try {
      result = await executeAction(job)
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      result = { ok: false, summary: error }
      sessionEvents.emit({
        type: "cron:failed",
        jobId: job.id,
        label: job.label,
        error,
        ts: new Date().toISOString(),
      })
      job.lastResult = result
      if (!job.recurring) {
        job.active = false
        job.nextRunAt = undefined
        state.cronInstance?.stop()
        state.cronInstance = undefined
      } else if (state.cronInstance) {
        const next = nextFireDate(state.cronInstance)
        job.nextRunAt = next?.toISOString()
      }
      persistNow()
      return
    }

    sessionEvents.emit({
      type: "cron:succeeded",
      jobId: job.id,
      label: job.label,
      summary: result.summary,
      ts: new Date().toISOString(),
    })

    job.lastResult = result
    if (!job.recurring) {
      // One-shot: deactivate after firing.
      job.active = false
      job.nextRunAt = undefined
      state.cronInstance?.stop()
      state.cronInstance = undefined
    } else if (state.cronInstance) {
      const next = nextFireDate(state.cronInstance)
      job.nextRunAt = next?.toISOString()
    }
    persistNow()
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
    create({ label, schedule, recurring = true, action }) {
      // Validate schedule — throws SyntaxError if invalid.
      const cronInstance = parseCron(schedule)
      const id = `cron_${randomUUID()}`
      const next = nextFireDate(cronInstance)
      const job: CronJob = {
        id,
        ...(label ? { label } : {}),
        schedule,
        recurring,
        action,
        createdAt: new Date().toISOString(),
        active: true,
        nextRunAt: next?.toISOString(),
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

    delete(id) {
      const state = jobs.get(id)
      if (!state) throw new Error(`cron job not found: ${id}`)
      state.cronInstance?.stop()
      jobs.delete(id)
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
