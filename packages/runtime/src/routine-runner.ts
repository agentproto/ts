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
}): RoutineRunner {
  const { registry, sessionEvents, resolveAgentAdapter, webhookNotifier } = opts
  const persistPath = opts.persistPath ?? DEFAULT_PERSIST_PATH()

  // Load persisted runs on init; interrupted runs are marked failed.
  const runs = loadRuns(persistPath)

  /** Flush the in-memory run map to disk atomically. Call on every mutation. */
  const persist = (): void => saveRuns(runs, persistPath)

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
      return desc.id
    } catch {
      return null
    }
  }

  /** Handle awaiting-input according to the step's policy. */
  const handleAwaitingInput = async (
    sessionId: string,
    step: RoutineStep,
    stepState: RoutineStepState,
    state: RunState,
  ): Promise<boolean> => {
    const policy = step.policy ?? { awaiting: "fail" }

    if (policy.awaiting === "auto-allow") {
      try {
        await registry.sendPrompt(sessionId, policy.prompt)
        return true
      } catch {
        stepState.error = "auto-allow prompt failed"
        return false
      }
    }

    if (policy.awaiting === "escalate") {
      const escalateUrl = policy.webhookUrl ?? state.run.notifyUrl
      if (escalateUrl) {
        void fetch(escalateUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            type: "routine:awaiting-input",
            runId: state.run.runId,
            routineId: state.run.routineId,
            stepIndex: stepState.index,
            stepLabel: step.label,
            sessionId,
          }),
          signal: AbortSignal.timeout(10_000),
        }).catch(() => undefined)
      }

      const timeoutMs = policy.timeoutMs ?? 300_000
      const response = await new Promise<string | null>(resolve => {
        const timer = setTimeout(() => resolve(null), timeoutMs)
        state.pendingResolve = {
          stepIndex: stepState.index,
          resolver: res => {
            clearTimeout(timer)
            resolve(res)
          },
        }
      })
      state.pendingResolve = undefined

      if (response === null) {
        stepState.error = "escalate timeout"
        return false
      }
      try {
        await registry.sendPrompt(sessionId, response)
        return true
      } catch {
        stepState.error = "escalate prompt failed"
        return false
      }
    }

    // policy "fail"
    stepState.error = "awaiting-input: policy=fail"
    return false
  }

  /** Execute a single step. Returns true on success. */
  const executeStep = async (
    step: RoutineStep,
    stepState: RoutineStepState,
    state: RunState,
    currentSessionId: string | null,
  ): Promise<{ ok: boolean; sessionId: string | null }> => {
    if (state.cancelled) return { ok: false, sessionId: currentSessionId }

    stepState.status = "running"
    stepState.startedAt = new Date().toISOString()
    persist()

    // Fan-in: wait for all listed sessions to complete first
    if (step.waitFor && step.waitFor.length > 0) {
      await Promise.all(step.waitFor.map(sid => waitTurnEnd(sid)))
    }

    if (state.cancelled) {
      stepState.status = "skipped"
      persist()
      return { ok: false, sessionId: currentSessionId }
    }

    let sessionId = currentSessionId

    // Spawn a new session if adapter is specified
    if (step.adapter) {
      const newId = await spawnSession(step, state)
      if (!newId) {
        stepState.status = "failed"
        stepState.error = `adapter "${step.adapter}" not found or spawn failed`
        stepState.endedAt = new Date().toISOString()
        persist()
        return { ok: false, sessionId: currentSessionId }
      }
      sessionId = newId
      state.run.result = { sessionIds: [...(state.run.result?.sessionIds ?? []), newId] }
    }

    // Send prompt if provided (and we have a session)
    if (step.prompt && sessionId) {
      try {
        await registry.sendPrompt(sessionId, step.prompt)
      } catch (err) {
        stepState.status = "failed"
        stepState.error = `sendPrompt failed: ${err instanceof Error ? err.message : String(err)}`
        stepState.endedAt = new Date().toISOString()
        persist()
        return { ok: false, sessionId }
      }

      // Wait for turn to end
      await waitTurnEnd(sessionId)

      // Check for awaiting-input
      const desc = registry.get(sessionId)
      if (desc?.awaitingInput) {
        state.run.status = "awaiting-input"
        persist()
        const continued = await handleAwaitingInput(sessionId, step, stepState, state)
        state.run.status = "running"
        persist()
        if (!continued) {
          stepState.status = "failed"
          stepState.endedAt = new Date().toISOString()
          persist()
          return { ok: false, sessionId }
        }
        // Wait for the continuation turn to end
        await waitTurnEnd(sessionId)
      }

      // Check exit code
      const descAfter = registry.get(sessionId)
      if (descAfter?.exitCode !== undefined && descAfter.exitCode !== 0) {
        stepState.status = "failed"
        stepState.error = `session exited with code ${descAfter.exitCode}`
        stepState.endedAt = new Date().toISOString()
        persist()
        return { ok: false, sessionId }
      }
    }

    stepState.status = "done"
    stepState.endedAt = new Date().toISOString()
    persist()
    return { ok: true, sessionId }
  }

  /** Main routine execution loop. Runs in background. */
  const runSteps = async (state: RunState, steps: RoutineStep[]): Promise<void> => {
    let currentSessionId: string | null = null

    for (let i = 0; i < steps.length; i++) {
      if (state.cancelled) break
      const step = steps[i]!
      const stepState = state.run.steps[i]!
      const { ok, sessionId } = await executeStep(step, stepState, state, currentSessionId)
      currentSessionId = sessionId
      if (!ok) {
        state.run.status = "failed"
        state.run.error = stepState.error
        state.run.endedAt = new Date().toISOString()
        // Mark remaining steps as skipped
        for (let j = i + 1; j < state.run.steps.length; j++) {
          state.run.steps[j]!.status = "skipped"
        }
        persist()
        if (state.run.notifyUrl) {
          void fetch(state.run.notifyUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ type: "routine:failed", runId: state.run.runId, error: state.run.error }),
            signal: AbortSignal.timeout(10_000),
          }).catch(() => undefined)
        }
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

    if (state.run.notifyUrl && !state.cancelled) {
      void fetch(state.run.notifyUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "routine:done",
          runId: state.run.runId,
          result: state.run.result,
        }),
        signal: AbortSignal.timeout(10_000),
      }).catch(() => undefined)
    }
  }

  // ── Public interface ───────────────────────────────────────────────

  return {
    async start(input) {
      const runId = `run_${randomUUID().slice(0, 8)}`
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
        result: { sessionIds: [] },
      }
      const state: RunState = { run, cancelled: false }
      runs.set(runId, state)
      persist()

      // Execute in background — caller gets the run descriptor immediately
      void runSteps(state, input.steps).catch(err => {
        run.status = "failed"
        run.error = err instanceof Error ? err.message : String(err)
        run.endedAt = new Date().toISOString()
        persist()
      })

      return run
    },

    status(runId) {
      return runs.get(runId)?.run
    },

    list() {
      return Array.from(runs.values()).map(s => s.run)
    },

    resolve(runId, stepIndex, response) {
      const state = runs.get(runId)
      if (!state) return
      if (
        state.pendingResolve &&
        state.pendingResolve.stepIndex === stepIndex
      ) {
        state.pendingResolve.resolver(response)
      }
    },

    cancel(runId) {
      const state = runs.get(runId)
      if (!state) return
      state.cancelled = true
      // Unblock any pending escalate
      if (state.pendingResolve) {
        state.pendingResolve.resolver("")
      }
      // Note: persist() will be called by the background runSteps loop once
      // it observes cancelled=true and transitions the run to "cancelled".
      // We don't persist here because the status is still "running" at this
      // point — the state machine will write the final "cancelled" status.
    },
  }
}
