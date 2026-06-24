/**
 * In-process routine runner — executes a sequence of RoutineStep[]
 * by reacting to SessionEventBus events instead of polling.
 *
 * State machine per run:
 *   idle → running → (per step) → done | failed | cancelled
 *
 * Fan-in: a step with `waitFor: string[]` waits for ALL listed
 * sessions to fire turn-end/exited before executing its own prompt.
 *
 * Awaiting-input policy:
 *   auto-allow → send the configured prompt and continue
 *   escalate   → POST webhook, wait for external `resolve()` call
 *   fail       → mark step/run as failed
 *
 * Persistence: runs are serialised to ~/.agentproto/routine-runs.json
 * (write-tmp + rename atomic swap) on every state mutation so they
 * survive daemon restarts. On load, any run with status "running" or
 * "awaiting-input" is immediately marked "failed" with reason
 * "interrupted by daemon restart" — these runs have no live sessions
 * to resume, so marking them failed is the only safe choice (an
 * in-flight run cannot be replayed without re-executing its steps,
 * which could trigger unintended side-effects).
 *
 * Persistence opt-in: persistence is DISABLED by default (persist defaults to
 * false when no persistPath is supplied) so that unit tests calling
 * createRoutineRunner() without a persistPath never touch ~/.agentproto/.
 * Pass persist:true (or supply a persistPath) to enable durable storage — the
 * production createGateway() call does both.
 */

import { randomUUID } from "node:crypto"
import { homedir } from "node:os"
import { join, dirname } from "node:path"
import { mkdirSync, readFileSync, existsSync, writeFileSync, renameSync } from "node:fs"
import type { SessionsRegistry } from "./sessions.js"
import type { SessionEventBus } from "./session-event-bus.js"
import type { AgentAdapterResolver } from "./http-server.js"
import type { WebhookNotifier } from "./webhook-notifier.js"

// ── Public types ─────────────────────────────────────────────────────

export type RoutinePolicy =
  | { awaiting: "auto-allow"; prompt: string }
  | { awaiting: "escalate"; webhookUrl?: string; timeoutMs?: number }
  | { awaiting: "fail" }

export interface RoutineStep {
  label: string
  /** Prompt to send to the agent. Omit to just wait without prompting. */
  prompt?: string
  /** Adapter slug for spawning a NEW session. Omit to reuse the current
   *  run's last session. */
  adapter?: string
  /** Fan-in: wait for ALL these session ids to finish before executing. */
  waitFor?: string[]
  policy?: RoutinePolicy
}

export type RoutineRunStatus =
  | "idle"
  | "running"
  | "awaiting-input"
  | "done"
  | "failed"
  | "cancelled"

export interface RoutineStepState {
  index: number
  label: string
  status: "pending" | "running" | "done" | "failed" | "skipped"
  sessionId?: string
  startedAt?: string
  endedAt?: string
  error?: string
}

export interface RoutineRun {
  runId: string
  routineId: string
  status: RoutineRunStatus
  startedAt: string
  endedAt?: string
  steps: RoutineStepState[]
  notifyUrl?: string
  error?: string
  result?: { sessionIds: string[] }
}

export interface RoutineRunner {
  /**
   * Start a routine. Returns immediately with the run descriptor
   * (status "running"). Steps execute in the background; subscribe
   * to the webhook or poll `status(runId)` for completion.
   */
  start(input: {
    routineId: string
    steps: RoutineStep[]
    workspaceSlug?: string
    cwd?: string
    notifyUrl?: string
  }): Promise<RoutineRun>

  status(runId: string): RoutineRun | undefined
  list(): RoutineRun[]

  /**
   * Provide an external answer to a step stuck in "escalate" awaiting-input.
   * The step's escalate timeout is cleared and the response is sent as the
   * next prompt.
   */
  resolve(runId: string, stepIndex: number, response: string): void

  cancel(runId: string): void
}

// ── Internal state per run ───────────────────────────────────────────

interface RunState {
  run: RoutineRun
  cancelled: boolean
  /** Filled by resolve() when a step is in "escalate" mode. */
  pendingResolve?: { stepIndex: number; resolver: (response: string) => void }
}

// ── Factory ──────────────────────────────────────────────────────────

const DEFAULT_PERSIST_PATH = (): string =>
  join(homedir(), ".agentproto", "routine-runs.json")

// ── Persistence helpers ──────────────────────────────────────────────

function loadRuns(persistPath: string): Map<string, RunState> {
  const result = new Map<string, RunState>()
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
    // Malformed file — start empty (documented: not an error)
    return result
  }
  if (!Array.isArray(parsed)) return result
  for (const item of parsed) {
    if (!item || typeof item !== "object" || typeof (item as RoutineRun).runId !== "string") continue
    // item passes only a minimal shape check (runId: string); remaining fields
    // are trusted as-written. Malformed entries are skipped above — this matches
    // the "malformed = ignored" recovery policy used by tunnel-registry and
    // supervisor for the same class of loader.
    const run = item as RoutineRun
    // Any run that was mid-flight cannot be resumed: mark it failed.
    // Reason: the in-process state machine and its live sessions are gone;
    // replaying steps would trigger unintended side-effects, so the safest
    // invariant is "interrupted = failed". Callers can re-start a new run.
    if (run.status === "running" || run.status === "awaiting-input") {
      run.status = "failed"
      run.error = "interrupted by daemon restart"
      run.endedAt = run.endedAt ?? new Date().toISOString()
    }
    result.set(run.runId, { run, cancelled: false })
  }
  return result
}

function saveRuns(runs: Map<string, RunState>, persistPath: string): void {
  try {
    mkdirSync(dirname(persistPath), { recursive: true })
    const payload = JSON.stringify(
      Array.from(runs.values()).map(s => s.run),
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

export function createRoutineRunner(opts: {
  registry: SessionsRegistry
  sessionEvents: SessionEventBus
  resolveAgentAdapter: AgentAdapterResolver
  webhookNotifier?: WebhookNotifier
  /** Absolute path for the persistence file. Defaults to ~/.agentproto/routine-runs.json */
  persistPath?: string
  /**
   * Enable filesystem persistence. Defaults to `true` when `persistPath` is
   * explicitly supplied, `false` otherwise. This mirrors the supervisor pattern
   * so that unit tests calling createRoutineRunner() without a persistPath never
   * write to ~/.agentproto/ — only the production createGateway() call (which
   * passes persist:true) opts in to durable storage.
   */
  persist?: boolean
}): RoutineRunner {
  const { registry, sessionEvents, resolveAgentAdapter, webhookNotifier } = opts
  const persistPath = opts.persistPath ?? DEFAULT_PERSIST_PATH()

  // Default false: tests (no opts.persist, no opts.persistPath)
  // don't touch ~/.agentproto. Set opts.persist:true in production
  // (createGateway does this), or supply a persistPath (which also opts in).
  const shouldPersist = opts.persist ?? (opts.persistPath !== undefined)

  // Load persisted runs on init only when persistence is enabled;
  // interrupted runs are marked failed.
  const runs = shouldPersist ? loadRuns(persistPath) : new Map<string, RunState>()

  /** Flush the in-memory run map to disk atomically. Call on every mutation. */
  const persist = (): void => {
    if (shouldPersist) saveRuns(runs, persistPath)
  }

  // ── Helpers ────────────────────────────────────────────────────────

  /** Wait for a session to emit turn-end or exited. */
  const waitTurnEnd = (sessionId: string): Promise<void> =>
    new Promise(resolve => {
      const unsubs: Array<() => void> = []
      const done = (): void => {
        for (const u of unsubs) u()
        resolve()
      }
      unsubs.push(
        sessionEvents.on("session:turn-end", ev => {
          if (ev.sessionId === sessionId) done()
        }),
      )
      unsubs.push(
        sessionEvents.on("session:awaiting-input", ev => {
          if (ev.sessionId === sessionId) done()
        }),
      )
      unsubs.push(
        sessionEvents.on("session:exited", ev => {
          if (ev.sessionId === sessionId) done()
        }),
      )
    })

  /** Spawn a new agent session for the given step. */
  const spawnSession = async (
    step: RoutineStep,
    state: RunState,
  ): Promise<string | null> => {
    if (!step.adapter) return null
    const resolved = await resolveAgentAdapter(step.adapter)
    if (!resolved) return null
    const cwd = state.run.result?.sessionIds.length
      ? registry.get(state.run.result.sessionIds.at(-1)!)?.cwd ?? process.cwd()
      : process.cwd()
    try {
      const agentSession = await resolved.startSession({ cwd })
      const desc = registry.spawnAgent({
        workspaceSlug: "default",
        cwd,
        agentSession,
        adapterSlug: step.adapter,
        label: `routine:${state.run.routineId}:${step.label}`,
        ...(resolved.commandPreview ? { commandPreview: resolved.commandPreview } : {}),
      })
      state.run.result ??= { sessionIds: [] }
      state.run.result.sessionIds.push(desc.id)
      return desc.id
    } catch {
      return null
    }
  }

  // ── Step executor ──────────────────────────────────────────────────

  const executeStep = async (
    stepDef: RoutineStep,
    stepState: RoutineStepState,
    state: RunState,
  ): Promise<void> => {
    stepState.status = "running"
    stepState.startedAt = new Date().toISOString()
    persist()

    try {
      // Fan-in: wait for all listed sessions
      if (stepDef.waitFor?.length) {
        await Promise.all(stepDef.waitFor.map(id => waitTurnEnd(id)))
      }

      if (state.cancelled) {
        stepState.status = "skipped"
        return
      }

      // Spawn / reuse session
      let sessionId: string | null = null
      if (stepDef.adapter) {
        sessionId = await spawnSession(stepDef, state)
        if (sessionId) stepState.sessionId = sessionId
      } else if (state.run.result?.sessionIds.length) {
        sessionId = state.run.result.sessionIds.at(-1) ?? null
        if (sessionId) stepState.sessionId = sessionId
      }

      if (state.cancelled) {
        stepState.status = "skipped"
        return
      }

      // Send prompt if any
      if (stepDef.prompt && sessionId) {
        await registry.sendPrompt(sessionId, stepDef.prompt)
      }

      // Wait for the session turn to end
      if (sessionId) {
        await waitTurnEnd(sessionId)
      }

      if (state.cancelled) {
        stepState.status = "skipped"
        return
      }

      // Check awaiting-input
      const desc = sessionId ? registry.get(sessionId) : undefined
      if (desc && (desc as { awaitingInput?: boolean }).awaitingInput) {
        const policy = stepDef.policy ?? { awaiting: "fail" }
        if (policy.awaiting === "auto-allow") {
          await registry.sendPrompt(sessionId!, policy.prompt)
          await waitTurnEnd(sessionId!)
        } else if (policy.awaiting === "escalate") {
          if (webhookNotifier && policy.webhookUrl) {
            await webhookNotifier.notify(policy.webhookUrl, {
              event: "routine:awaiting-input",
              runId: state.run.runId,
              stepIndex: stepState.index,
            })
          }
          state.run.status = "awaiting-input"
          persist()
          // Wait for external resolve()
          const response = await new Promise<string>((res, rej) => {
            const timeoutMs = policy.timeoutMs ?? 300_000
            const timer = setTimeout(() => {
              state.pendingResolve = undefined
              rej(new Error("escalate timeout"))
            }, timeoutMs)
            state.pendingResolve = {
              stepIndex: stepState.index,
              resolver: (r: string) => {
                clearTimeout(timer)
                state.pendingResolve = undefined
                res(r)
              },
            }
          })
          state.run.status = "running"
          persist()
          if (sessionId) {
            await registry.sendPrompt(sessionId, response)
            await waitTurnEnd(sessionId)
          }
        } else {
          // policy.awaiting === "fail"
          throw new Error("step failed: session awaiting input")
        }
      }

      stepState.status = "done"
      stepState.endedAt = new Date().toISOString()
      persist()
    } catch (err) {
      stepState.status = "failed"
      stepState.endedAt = new Date().toISOString()
      stepState.error = err instanceof Error ? err.message : String(err)
      persist()
      throw err
    }
  }

  // ── Run executor ───────────────────────────────────────────────────

  const executeRun = async (state: RunState, steps: RoutineStep[]): Promise<void> => {
    try {
      for (let i = 0; i < steps.length; i++) {
        if (state.cancelled) break
        const stepState = state.run.steps[i]!
        await executeStep(steps[i]!, stepState, state)
        if (stepState.status === "failed") {
          state.run.status = "failed"
          state.run.error = stepState.error
          state.run.endedAt = new Date().toISOString()
          persist()
          return
        }
      }
      if (state.cancelled) {
        state.run.status = "cancelled"
      } else {
        state.run.status = "done"
      }
      state.run.endedAt = new Date().toISOString()
      persist()

      // Fire webhook if requested
      if (state.run.notifyUrl && webhookNotifier) {
        await webhookNotifier.notify(state.run.notifyUrl, {
          event: "routine:completed",
          run: state.run,
        }).catch(() => { /* best-effort */ })
      }
    } catch {
      state.run.status = "failed"
      state.run.endedAt = new Date().toISOString()
      persist()
    }
  }

  // ── Public interface ───────────────────────────────────────────────

  return {
    start: async (input) => {
      const runId = `run_${randomUUID()}`
      const run: RoutineRun = {
        runId,
        routineId: input.routineId,
        status: "running",
        startedAt: new Date().toISOString(),
        steps: input.steps.map((s, i) => ({
          index: i,
          label: s.label,
          status: "pending",
        })),
        ...(input.notifyUrl ? { notifyUrl: input.notifyUrl } : {}),
      }
      const state: RunState = { run, cancelled: false }
      runs.set(runId, state)
      persist()
      // Fire-and-forget: run steps in background
      void executeRun(state, input.steps)
      return run
    },

    status: (runId) => runs.get(runId)?.run,

    list: () => Array.from(runs.values()).map(s => s.run),

    resolve: (runId, stepIndex, response) => {
      const state = runs.get(runId)
      if (!state) return
      const pr = state.pendingResolve
      if (pr && pr.stepIndex === stepIndex) {
        pr.resolver(response)
      }
    },

    cancel: (runId) => {
      const state = runs.get(runId)
      if (!state) return
      state.cancelled = true
      // If the run is already terminal, leave it; otherwise mark cancelled
      if (state.run.status === "running" || state.run.status === "awaiting-input") {
        state.run.status = "cancelled"
        state.run.endedAt = new Date().toISOString()
        persist()
      }
    },
  }
}
