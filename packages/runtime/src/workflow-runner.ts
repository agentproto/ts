/**
 * In-process workflow runner — executes an ordered list of WorkflowStage[],
 * each stage containing one or more parallel WorkflowStep[], with an
 * explicit barrier between stages.
 *
 * As of the engine-unification refactor, the internals delegate to
 * `runWorkflow` from @agentproto/workflow-runtime via a translation layer:
 * each stage becomes a `ParallelStep` with one `AgentStep` branch per step;
 * stages are chained as a flat `steps[]`. The public API —
 * `WorkflowRunner.start()` / `status()` / `cancel()` — is preserved
 * unchanged.
 *
 * Persistence: runs are serialised to ~/.agentproto/workflow-runs.json
 * (write-tmp + rename atomic swap) on every state mutation, same pattern
 * as routine-runner.ts. On load, any run with status "running" or
 * "awaiting-input" is immediately marked "failed" with reason
 * "interrupted by daemon restart".
 *
 * Persistence opt-in: disabled by default (persist defaults to false when
 * no persistPath is supplied) so unit tests never touch ~/.agentproto/.
 */

import { randomUUID } from "node:crypto"
import { homedir } from "node:os"
import { join, dirname } from "node:path"
import { mkdirSync, readFileSync, existsSync, writeFileSync, renameSync } from "node:fs"
import { runWorkflow } from "@agentproto/workflow-runtime"
import type { RuntimeWorkflow } from "@agentproto/workflow-runtime"
import type { SessionsRegistry } from "./sessions.js"
import type { SessionEventBus } from "./session-event-bus.js"
import type { AgentAdapterResolver } from "./http-server.js"
import type { WebhookNotifier } from "./webhook-notifier.js"
import type { RoutinePolicy, RoutineStepState } from "./routine-runner.js"
import { SessionsRegistryAgentHost } from "./sessions-registry-agent-host.js"

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
  start(input: {
    workflowId: string
    stages: WorkflowStage[]
    workspaceSlug?: string
    cwd?: string
    notifyUrl?: string
  }): Promise<WorkflowRun>

  status(runId: string): WorkflowRun | undefined
  list(): WorkflowRun[]

  resolve(runId: string, stageIndex: number, stepIndex: number, response: string): void

  cancel(runId: string): void
}

// ── Internal state per run ───────────────────────────────────────────

interface RunState {
  run: WorkflowRun
  cancelled: boolean
  cwd?: string
  workspaceSlug?: string
  abort: AbortController
  /** Original stages — retained so sessionRef lookups can resolve step labels. */
  stages: WorkflowStage[]
  pendingResolve?: { stageIndex: number; stepIndex: number; resolver: (response: string) => void }
}

// ── Translation: WorkflowStage[] → RuntimeWorkflow ──────────────────

function translateStages(
  stages: WorkflowStage[],
  workflowId: string,
): RuntimeWorkflow {
  const steps = stages.map((stage, si): RuntimeWorkflow["steps"][number] => {
    const branches = stage.steps.map((step) => ({
      id: step.label,
      steps: [
        {
          kind: "agent" as const,
          id: step.label,
          ...(step.adapter !== undefined ? { adapter: step.adapter } : {}),
          ...(step.sessionRef !== undefined ? { sessionRef: step.sessionRef } : {}),
          prompt: (() => step.prompt ?? "") as (() => string),
          policy: step.policy ?? { awaiting: "fail" as const },
        },
      ],
    }))
    return {
      kind: "parallel" as const,
      id: `stage-${si}`,
      branches,
    }
  })

  return {
    id: workflowId,
    steps,
  }
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
    result.set(run.runId, { run, cancelled: false, abort: new AbortController(), stages: [] })
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

function fireNotifyUrl(run: WorkflowRun): void {
  if (!run.notifyUrl) return
  void fetch(run.notifyUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      type: run.status === "cancelled" ? "workflow:cancelled" : run.status === "done" ? "workflow:done" : "workflow:failed",
      runId: run.runId,
      result: run.result,
    }),
    signal: AbortSignal.timeout(10_000),
  }).catch(() => undefined)
}

// ── Helpers ──────────────────────────────────────────────────────────

function resolveStepSessionId(
  step: WorkflowStep,
  agents: SessionsRegistryAgentHost,
): string | undefined {
  if (step.adapter) {
    return agents.resolveByLabel(step.label)
  }
  if (step.sessionRef) {
    return agents.resolveByLabel(step.sessionRef)
  }
  return undefined
}

function fillStepStates(
  stages: WorkflowStageState[],
  defs: WorkflowStage[],
  agents: SessionsRegistryAgentHost,
): string[] {
  const sessionIds: string[] = []
  for (let si = 0; si < stages.length; si++) {
    const stage = stages[si]!
    const def = defs[si]
    if (!def) continue
    for (let i = 0; i < stage.steps.length; i++) {
      const stepState = stage.steps[i]!
      const stepDef = def.steps[i]
      if (!stepDef) continue
      stepState.sessionId = resolveStepSessionId(stepDef, agents)
      if (stepState.sessionId) sessionIds.push(stepState.sessionId)
    }
  }
  return sessionIds
}

// ── Background execution ─────────────────────────────────────────────

async function executeRunWorkflow(
  state: RunState,
  runtimeWf: RuntimeWorkflow,
  agents: SessionsRegistryAgentHost,
  signal: AbortSignal,
): Promise<void> {
  try {
    await runWorkflow({
      workflow: runtimeWf,
      agents,
      signal,
      cwd: state.cwd,
      workspaceSlug: state.workspaceSlug,
    })

    // Success — mark all stages/steps done.
    for (const stage of state.run.stages) {
      stage.status = "done"
      for (const step of stage.steps) {
        step.status = "done"
        step.endedAt = new Date().toISOString()
      }
    }
    state.run.status = "done"
    state.run.endedAt = new Date().toISOString()

    const sessionIds = fillStepStates(state.run.stages, state.stages, agents)
    if (sessionIds.length > 0) state.run.result = { sessionIds }
  } catch (err) {
    if (signal.aborted) {
      state.run.status = "cancelled"
      state.run.endedAt = new Date().toISOString()
    } else {
      const errMsg = err instanceof Error ? err.message : String(err)
      state.run.status = "failed"
      state.run.error = errMsg
      state.run.endedAt = new Date().toISOString()

      // Mark stage 0 as failed (common case) and the rest as pending.
      for (let i = 0; i < state.run.stages.length; i++) {
        const stage = state.run.stages[i]!
        if (i === 0) {
          stage.status = "failed"
          for (const step of stage.steps) {
            step.status = "failed"
            step.endedAt = new Date().toISOString()
            step.error = errMsg
          }
        }
        // else: remaining stages stay "pending"
      }
    }
  }

  fireNotifyUrl(state.run)
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
          status: "pending" as const,
          steps: stage.steps.map((s, i) => ({
            index: i,
            label: s.label,
            status: "pending" as const,
          })),
        })),
        ...(input.notifyUrl ? { notifyUrl: input.notifyUrl } : {}),
      }
      const abort = new AbortController()
      const state: RunState = {
        run,
        cancelled: false,
        abort,
        stages: input.stages,
        ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
        ...(input.workspaceSlug !== undefined ? { workspaceSlug: input.workspaceSlug } : {}),
      }
      runs.set(runId, state)
      persist()

      // Translate stages → RuntimeWorkflow and launch.
      const workflow = translateStages(input.stages, input.workflowId)
      const agents = new SessionsRegistryAgentHost(
        registry,
        sessionEvents,
        resolveAgentAdapter,
        {
          workspaceSlug: input.workspaceSlug,
          cwd: input.cwd,
          notifyUrl: input.notifyUrl,
        },
      )

      void executeRunWorkflow(state, workflow, agents, abort.signal).then(() => {
        persist()
      })

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
      state.abort.abort()
      if (state.run.status === "running" || state.run.status === "awaiting-input") {
        state.run.status = "cancelled"
        state.run.endedAt = new Date().toISOString()
        persist()
      }
    },
  }
}