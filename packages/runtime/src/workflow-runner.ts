/**
 * In-process workflow runner — executes an ordered list of WorkflowStage[],
 * each stage containing one or more parallel WorkflowStep[], with an
 * explicit barrier between stages (mirrors `parallel()`/`pipeline()`
 * "stage" semantics from harness-style orchestration tools).
 *
 * This is a SIBLING primitive to RoutineRunner, not an extension of it:
 * RoutineRunner's `RoutineStep[]` is a flat sequential list with per-step
 * `waitFor` fan-in; WorkflowRunner's unit of sequencing is a *stage* (a
 * group of steps that all run concurrently, with the barrier gating
 * entry into the next stage). Existing `routine_*` consumers (tests,
 * skill docs) depend on the flat-sequence shape, so RoutineRunner is
 * left untouched — see PLAN.md "Design decision" for the rationale.
 *
 * State machine per run:
 *   idle → running → (per stage, all steps in parallel) → done | failed | cancelled
 *
 * Barrier: a stage's steps all run via Promise.all — stage N+1 does not
 * start until every step of stage N reaches a terminal per-step state
 * (done/failed/skipped). Any step failure fails the whole stage (and run);
 * remaining stages are skipped, same "step failed -> run failed" invariant
 * RoutineRunner uses.
 *
 * Cross-stage session reuse: a step may omit `adapter` and set `sessionRef`
 * to an earlier step's `label` (any prior stage) to send its prompt to that
 * step's spawned session instead of spawning a new one — this is what makes
 * "verify what stage 1 produced" expressible. Omitting both `adapter` and
 * `sessionRef` reuses the run's most-recently-spawned session (mirrors
 * RoutineRunner's fallback).
 *
 * Pipeline (no cross-item barrier — item A in stage 3 while item B is
 * still in stage 1) is NOT implemented here; it is architecturally a
 * different model (per-item independent chains rather than stage-wide
 * barriers) and is documented as a follow-up per PLAN.md. Stage-barrier
 * alone covers the `parallel()` half of the harness-style primitive.
 *
 * Persistence: runs are serialised to ~/.agentproto/workflow-runs.json
 * (write-tmp + rename atomic swap) on every state mutation, same pattern
 * as routine-runner.ts. On load, any run with status "running" or
 * "awaiting-input" is immediately marked "failed" with reason
 * "interrupted by daemon restart" — an in-flight run cannot be resumed
 * without re-executing steps, which could trigger unintended side-effects.
 *
 * Persistence opt-in: disabled by default (persist defaults to false when
 * no persistPath is supplied) so unit tests never touch ~/.agentproto/.
 */

import { randomUUID } from "node:crypto"
import { homedir } from "node:os"
import { join, dirname } from "node:path"
import { mkdirSync, readFileSync, existsSync, writeFileSync, renameSync } from "node:fs"
import type { SessionsRegistry } from "./sessions.js"
import type { SessionEventBus } from "./session-event-bus.js"
import type { AgentAdapterResolver } from "./http-server.js"
import type { WebhookNotifier } from "./webhook-notifier.js"
import type { RoutinePolicy, RoutineStepState } from "./routine-runner.js"

// ── Public types ─────────────────────────────────────────────────────

export interface WorkflowStep {
  label: string
  /** Prompt to send to the agent. Omit to just spawn/reuse and wait. */
  prompt?: string
  /** Adapter slug for spawning a NEW session. Omit to reuse a prior session. */
  adapter?: string
  /** Reuse the session spawned by an earlier step (any prior stage),
   *  identified by that step's `label`. Ignored if `adapter` is set. */
  sessionRef?: string
  policy?: RoutinePolicy
}

export interface WorkflowStage {
  /** Optional label for this stage (surfaced in status output). */
  label?: string
  steps: WorkflowStep[]
}

export type WorkflowRunStatus =
  | "idle"
  | "running"
  | "awaiting-input"
  | "done"
  | "failed"
  | "cancelled"

export interface WorkflowStageState {
  index: number
  label?: string
  status: "pending" | "running" | "done" | "failed" | "skipped"
  steps: RoutineStepState[]
}

export interface WorkflowRun {
  runId: string
  workflowId: string
  status: WorkflowRunStatus
  startedAt: string
  endedAt?: string
  stages: WorkflowStageState[]
  notifyUrl?: string
  error?: string
  result?: { sessionIds: string[] }
}

export interface WorkflowRunner {
  /**
   * Start a workflow. Returns immediately with the run descriptor
   * (status "running"). Stages execute in the background; poll with
   * `status(runId)` for completion.
   */
  start(input: {
    workflowId: string
    stages: WorkflowStage[]
    workspaceSlug?: string
    cwd?: string
    notifyUrl?: string
  }): Promise<WorkflowRun>

  status(runId: string): WorkflowRun | undefined
  list(): WorkflowRun[]

  /**
   * Provide an external answer to a step stuck in "escalate" awaiting-input.
   * Identified by (stageIndex, stepIndex) since steps within a stage run
   * concurrently.
   */
  resolve(runId: string, stageIndex: number, stepIndex: number, response: string): void

  cancel(runId: string): void
}

// ── Internal state per run ───────────────────────────────────────────

interface RunState {
  run: WorkflowRun
  cancelled: boolean
  cwd?: string
  workspaceSlug?: string
  /** label -> spawned sessionId, accumulated across all stages so later
   *  stages can reference earlier steps' sessions via `sessionRef`. */
  sessionsByLabel: Map<string, string>
  pendingResolve?: { stageIndex: number; stepIndex: number; resolver: (response: string) => void }
}

// ── Factory ──────────────────────────────────────────────────────────

const DEFAULT_PERSIST_PATH = (): string =>
  join(homedir(), ".agentproto", "workflow-runs.json")

// ── Persistence helpers (mirrors routine-runner.ts exactly) ──────────

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
    return result
  }
  if (!Array.isArray(parsed)) return result
  for (const item of parsed) {
    if (!item || typeof item !== "object" || typeof (item as WorkflowRun).runId !== "string") continue
    const run = item as WorkflowRun
    if (run.status === "running" || run.status === "awaiting-input") {
      run.status = "failed"
      run.error = "interrupted by daemon restart"
      run.endedAt = run.endedAt ?? new Date().toISOString()
    }
    const sessionsByLabel = new Map<string, string>()
    for (const stage of run.stages ?? []) {
      for (const step of stage.steps ?? []) {
        if (step.sessionId) sessionsByLabel.set(step.label, step.sessionId)
      }
    }
    result.set(run.runId, { run, cancelled: false, sessionsByLabel })
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

export function createWorkflowRunner(opts: {
  registry: SessionsRegistry
  sessionEvents: SessionEventBus
  resolveAgentAdapter: AgentAdapterResolver
  webhookNotifier?: WebhookNotifier
  /** Absolute path for the persistence file. Defaults to ~/.agentproto/workflow-runs.json */
  persistPath?: string
  /** Enable filesystem persistence. Defaults to `true` when `persistPath` is
   *  explicitly supplied, `false` otherwise — mirrors routine-runner.ts. */
  persist?: boolean
}): WorkflowRunner {
  const { registry, sessionEvents, resolveAgentAdapter } = opts
  const persistPath = opts.persistPath ?? DEFAULT_PERSIST_PATH()
  const shouldPersist = opts.persist ?? (opts.persistPath !== undefined)

  const runs = shouldPersist ? loadRuns(persistPath) : new Map<string, RunState>()

  const persist = (): void => {
    if (shouldPersist) saveRuns(runs, persistPath)
  }

  // ── Helpers (waitTurnEnd is identical to routine-runner.ts) ─────────

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
      const desc = registry.get(sessionId)
      const isTerminal =
        desc?.status === "exited" ||
        desc?.status === "killed" ||
        desc?.status === "error" ||
        desc?.awaitingInput === true
      if (isTerminal) done()
    })

  const spawnSession = async (
    step: WorkflowStep,
    state: RunState,
  ): Promise<string | null> => {
    if (!step.adapter) return null
    const resolved = await resolveAgentAdapter(step.adapter)
    if (!resolved) return null
    const lastSessionId = state.run.result?.sessionIds.at(-1)
    const cwd =
      state.cwd ??
      (lastSessionId ? registry.get(lastSessionId)?.cwd : undefined) ??
      process.cwd()
    try {
      const agentSession = await resolved.startSession({ cwd })
      const desc = registry.spawnAgent({
        workspaceSlug: state.workspaceSlug ?? "default",
        cwd,
        agentSession,
        adapterSlug: step.adapter,
        label: `workflow:${state.run.workflowId}:${step.label}`,
        ...(resolved.commandPreview ? { commandPreview: resolved.commandPreview } : {}),
      })
      state.run.result ??= { sessionIds: [] }
      state.run.result.sessionIds.push(desc.id)
      return desc.id
    } catch {
      return null
    }
  }

  // ── Step executor (runs concurrently with its stage siblings) ──────

  const executeStep = async (
    stepDef: WorkflowStep,
    stepState: RoutineStepState,
    stageIndex: number,
    state: RunState,
  ): Promise<void> => {
    stepState.status = "running"
    stepState.startedAt = new Date().toISOString()
    persist()

    try {
      if (state.cancelled) {
        stepState.status = "skipped"
        return
      }

      // Resolve session: spawn new, reuse by sessionRef, or fall back to
      // the run's most-recently-spawned session.
      let sessionId: string | null = null
      if (stepDef.adapter) {
        sessionId = await spawnSession(stepDef, state)
        if (sessionId) {
          stepState.sessionId = sessionId
          state.sessionsByLabel.set(stepDef.label, sessionId)
        }
      } else if (stepDef.sessionRef) {
        sessionId = state.sessionsByLabel.get(stepDef.sessionRef) ?? null
        if (sessionId) stepState.sessionId = sessionId
      } else if (state.run.result?.sessionIds.length) {
        sessionId = state.run.result.sessionIds.at(-1) ?? null
        if (sessionId) stepState.sessionId = sessionId
      }

      if (state.cancelled) {
        stepState.status = "skipped"
        return
      }

      if (sessionId) {
        const turnEnded = waitTurnEnd(sessionId)
        if (stepDef.prompt) {
          await registry.sendPrompt(sessionId, stepDef.prompt)
        }
        await turnEnded
      }

      if (state.cancelled) {
        stepState.status = "skipped"
        return
      }

      const desc = sessionId ? registry.get(sessionId) : undefined
      if (desc && (desc as { awaitingInput?: boolean }).awaitingInput) {
        const policy = stepDef.policy ?? { awaiting: "fail" }
        if (policy.awaiting === "auto-allow") {
          const turnEnded = waitTurnEnd(sessionId!)
          await registry.sendPrompt(sessionId!, policy.prompt)
          await turnEnded
        } else if (policy.awaiting === "escalate") {
          const escalateUrl = policy.webhookUrl ?? state.run.notifyUrl
          if (escalateUrl) {
            void fetch(escalateUrl, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                type: "workflow:awaiting-input",
                runId: state.run.runId,
                workflowId: state.run.workflowId,
                stageIndex,
                stepIndex: stepState.index,
                stepLabel: stepDef.label,
              }),
              signal: AbortSignal.timeout(10_000),
            }).catch(() => undefined)
          }
          state.run.status = "awaiting-input"
          persist()
          const response = await new Promise<string>((res, rej) => {
            const timeoutMs = policy.timeoutMs ?? 300_000
            const timer = setTimeout(() => {
              state.pendingResolve = undefined
              rej(new Error("escalate timeout"))
            }, timeoutMs)
            state.pendingResolve = {
              stageIndex,
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
            const turnEnded = waitTurnEnd(sessionId)
            await registry.sendPrompt(sessionId, response)
            await turnEnded
          }
        } else {
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

  // ── Stage executor — all steps run in parallel; this is the barrier ─

  const executeStage = async (
    stageDef: WorkflowStage,
    stageState: WorkflowStageState,
    state: RunState,
  ): Promise<void> => {
    stageState.status = "running"
    persist()

    const outcomes = await Promise.allSettled(
      stageDef.steps.map((step, i) => executeStep(step, stageState.steps[i]!, stageState.index, state)),
    )

    if (state.cancelled) {
      stageState.status = "skipped"
      return
    }

    const failed = outcomes.find(o => o.status === "rejected")
    stageState.status = failed ? "failed" : "done"
    persist()
  }

  // ── Run executor ───────────────────────────────────────────────────

  const executeRun = async (state: RunState, stages: WorkflowStage[]): Promise<void> => {
    try {
      for (let i = 0; i < stages.length; i++) {
        if (state.cancelled) break
        const stageState = state.run.stages[i]!
        await executeStage(stages[i]!, stageState, state)
        if (stageState.status === "failed") {
          state.run.status = "failed"
          state.run.error = stageState.steps.find(s => s.status === "failed")?.error
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

      if (state.run.notifyUrl) {
        void fetch(state.run.notifyUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            type: state.cancelled ? "workflow:cancelled" : "workflow:done",
            runId: state.run.runId,
            result: state.run.result,
          }),
          signal: AbortSignal.timeout(10_000),
        }).catch(() => undefined)
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
      const runId = `wfrun_${randomUUID()}`
      const run: WorkflowRun = {
        runId,
        workflowId: input.workflowId,
        status: "running",
        startedAt: new Date().toISOString(),
        stages: input.stages.map((stage, si) => ({
          index: si,
          ...(stage.label !== undefined ? { label: stage.label } : {}),
          status: "pending",
          steps: stage.steps.map((s, i) => ({
            index: i,
            label: s.label,
            status: "pending",
          })),
        })),
        ...(input.notifyUrl ? { notifyUrl: input.notifyUrl } : {}),
      }
      const state: RunState = {
        run,
        cancelled: false,
        sessionsByLabel: new Map(),
        ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
        ...(input.workspaceSlug !== undefined ? { workspaceSlug: input.workspaceSlug } : {}),
      }
      runs.set(runId, state)
      persist()
      void executeRun(state, input.stages)
      return run
    },

    status: (runId) => runs.get(runId)?.run,

    list: () => Array.from(runs.values()).map(s => s.run),

    resolve: (runId, stageIndex, stepIndex, response) => {
      const state = runs.get(runId)
      if (!state) return
      const pr = state.pendingResolve
      if (pr && pr.stageIndex === stageIndex && pr.stepIndex === stepIndex) {
        pr.resolver(response)
      }
    },

    cancel: (runId) => {
      const state = runs.get(runId)
      if (!state) return
      state.cancelled = true
      if (state.run.status === "running" || state.run.status === "awaiting-input") {
        state.run.status = "cancelled"
        state.run.endedAt = new Date().toISOString()
        persist()
      }
    },
  }
}
