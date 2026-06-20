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
 * State is in-memory only (MVP). TODO: persist to
 * ~/.agentproto/routine-runs.json for restart resilience.
 */

import { randomUUID } from "node:crypto"
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

export function createRoutineRunner(opts: {
  registry: SessionsRegistry
  sessionEvents: SessionEventBus
  resolveAgentAdapter: AgentAdapterResolver
  webhookNotifier?: WebhookNotifier
}): RoutineRunner {
  const { registry, sessionEvents, resolveAgentAdapter, webhookNotifier } = opts
  const runs = new Map<string, RunState>()

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

    // Fan-in: wait for all listed sessions to complete first
    if (step.waitFor && step.waitFor.length > 0) {
      await Promise.all(step.waitFor.map(sid => waitTurnEnd(sid)))
    }

    if (state.cancelled) {
      stepState.status = "skipped"
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
        return { ok: false, sessionId }
      }

      // Wait for turn to end
      await waitTurnEnd(sessionId)

      // Check for awaiting-input
      const desc = registry.get(sessionId)
      if (desc?.awaitingInput) {
        state.run.status = "awaiting-input"
        const continued = await handleAwaitingInput(sessionId, step, stepState, state)
        state.run.status = "running"
        if (!continued) {
          stepState.status = "failed"
          stepState.endedAt = new Date().toISOString()
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
        return { ok: false, sessionId }
      }
    }

    stepState.status = "done"
    stepState.endedAt = new Date().toISOString()
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

      // Execute in background — caller gets the run descriptor immediately
      void runSteps(state, input.steps).catch(err => {
        run.status = "failed"
        run.error = err instanceof Error ? err.message : String(err)
        run.endedAt = new Date().toISOString()
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
    },
  }
}
