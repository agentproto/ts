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
import type { AgentSandboxRef, RuntimeWorkflow } from "@agentproto/workflow-runtime"
import type { StepCache } from "@agentproto/workflow-runtime"
import { loadWorkflowHandle } from "@agentproto/workflow-loader"
import type { WorkflowHandle } from "@agentproto/workflow"
import type { SessionsRegistry } from "./sessions.js"
import type { SessionEventBus } from "./session-event-bus.js"
import type { AgentAdapterResolver } from "./http-server.js"
import type { SandboxProviderResolver } from "./sandbox-adapters.js"
import type { WebhookNotifier } from "./webhook-notifier.js"
import type { RoutinePolicy, RoutineStepState } from "./routine-runner.js"
import { SessionsRegistryAgentHost } from "./sessions-registry-agent-host.js"
import { createFileStepCache } from "./workflow-step-cache.js"

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
  /** Run this step's session inside a sandbox — a provider slug (e.g.
   *  `"local"`, `"e2b"`) or an inline AIP-36 spec object. Only meaningful
   *  with `adapter`. Requires the runner to be wired with
   *  `resolveSandboxProvider`; fails loudly otherwise. */
  sandbox?: AgentSandboxRef
  policy?: RoutinePolicy
  /** Cache this step's output under the run's `cacheKey` — opt-in, for idempotent steps. */
  cacheable?: boolean
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
    /** Enable journal caching for this run; cacheable steps replay unchanged outputs. */
    cacheKey?: string
  }): Promise<WorkflowRun>

  startFromFile(input: {
    path: string
    input?: unknown
    cwd?: string
    workspaceSlug?: string
    cacheKey?: string
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
  /**
   * Reserved for a future durable suspend/resume of an escalated step. NOT set
   * by the current engine: an `escalate` policy fails the step fast
   * (`SessionsRegistryAgentHost.onAwaitingInput` throws) instead of suspending
   * on a resolver, so `resolve()` is a no-op today. Kept as a documented stub
   * rather than removed, to avoid a breaking change for the `http-server` /
   * `orchestration-tools` callers pending the durable-suspend follow-up.
   */
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
          ...(step.sandbox !== undefined ? { sandbox: step.sandbox } : {}),
          ...(step.cacheable ? { cacheable: true } : {}),
          prompt: () => step.prompt ?? "",
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

// ── Reverse translation: RuntimeWorkflow → WorkflowStage[] ───────────
// `startFromFile` wraps a compiled WORKFLOW.md in a single outer run. The
// workflow-runtime's AgentSessionHost stores spawned sessions under the
// *inner* AgentStep ids (e.g. "review"), but fillStepStates was looking up
// the generic outer "workflow" label and never found them. Walk the compiled
// runtime workflow and expose its agent step ids as WorkflowStage labels so
// status output + downstream diagnostics can resolve the real sessions.

type RuntimeStep = RuntimeWorkflow["steps"][number]

interface CollectedAgentStep {
  id: string
  adapter?: string
  sessionRef?: string
}

function collectAgentSteps(steps: readonly RuntimeStep[]): CollectedAgentStep[] {
  const collected: CollectedAgentStep[] = []
  for (const step of steps) {
    if (step.kind === "agent") {
      const adapter = typeof step.adapter === "string" ? step.adapter : undefined
      collected.push({ id: step.id, adapter, sessionRef: step.sessionRef })
    } else if (step.kind === "parallel") {
      for (const branch of step.branches) collected.push(...collectAgentSteps(branch.steps))
    } else if (step.kind === "group") {
      collected.push(...collectAgentSteps(step.steps))
    } else if (step.kind === "map") {
      // We can't enumerate map items statically, but the body template is a
      // function that returns a RunStep. There's no static steps list to walk.
      // Skip — dynamic agent steps inside a map are out of scope for this
      // diagnostic mapping; the host still tracks them by label at runtime.
    } else if (step.kind === "pipeline") {
      for (const stage of step.stages) {
        // stage is a function returning a RunStep; can't be walked statically.
      }
    } else if (step.kind === "branch") {
      collected.push(...collectAgentSteps(step.then))
      if (step.otherwise) collected.push(...collectAgentSteps(step.otherwise))
    } else if (step.kind === "loop") {
      collected.push(...collectAgentSteps(step.body))
    } else if (step.kind === "subworkflow") {
      collected.push(...collectAgentSteps(step.workflow.steps))
    }
    // tool / transform / approval / suspend have no agent sessions.
  }
  return collected
}

function runtimeWorkflowToStages(workflow: RuntimeWorkflow): WorkflowStage[] {
  const agents = collectAgentSteps(workflow.steps)
  if (agents.length === 0) {
    // No agent steps in this compiled workflow — keep the generic outer stage
    // so non-agent (tool-only) workflows behave exactly as before.
    return [{ steps: [{ label: "workflow" }] }]
  }
  return [
    {
      steps: agents.map((a) => ({
        label: a.id,
        ...(a.adapter !== undefined ? { adapter: a.adapter } : {}),
        ...(a.sessionRef !== undefined ? { sessionRef: a.sessionRef } : {}),
      })),
    },
  ]
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
  if (step.sessionRef) {
    return agents.resolveByLabel(step.sessionRef)
  }
  // Fall through to the step's own label even when `adapter` is unset: a
  // compiled WORKFLOW.md whose entry declares `adapter` as a SELECTOR
  // function is erased to `adapter: undefined` in the stage mapping
  // (`collectAgentSteps` only keeps string adapters), but the host still
  // registered the spawned session under this step id — without this, such
  // steps reported no sessionId and callers fell back to fuzzy recovery.
  return agents.resolveByLabel(step.label)
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
  cache?: StepCache,
  cacheKey?: string,
  input?: unknown,
): Promise<void> {
  try {
    await runWorkflow({
      workflow: runtimeWf,
      agents,
      signal,
      cwd: state.cwd,
      workspaceSlug: state.workspaceSlug,
      input,
      ...(cache ? { cache, cacheKey } : {}),
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

      // Resolve step sessionIds on FAILURE too — previously only the success
      // path did this, so a run whose agent session spawned and then errored
      // reported failed steps with NO sessionId, leaving callers (e.g. the CI
      // driver) blind: no handle to `agent_output` the dead session's last
      // words. The host's label map is populated at spawn time, so any
      // session that got as far as spawning resolves here.
      const sessionIds = fillStepStates(state.run.stages, state.stages, agents)
      if (sessionIds.length > 0) state.run.result = { sessionIds }
    }
  }

  fireNotifyUrl(state.run)
}

export function createWorkflowRunner(opts: {
  registry: SessionsRegistry
  sessionEvents: SessionEventBus
  resolveAgentAdapter: AgentAdapterResolver
  webhookNotifier?: WebhookNotifier
  /** Sandbox provider resolver for `sandbox`-carrying agent steps — the same
   *  resolver `agent_start.sandbox` uses. Omitted ⇒ a sandbox step fails
   *  loudly (never a silent host spawn). */
  resolveSandboxProvider?: SandboxProviderResolver
  /** Absolute path for the persistence file. Defaults to ~/.agentproto/workflow-runs.json */
  persistPath?: string
  /** Enable filesystem persistence. Defaults to `true` when `persistPath` is
   *  explicitly supplied, `false` otherwise — mirrors routine-runner.ts. */
  persist?: boolean
  /**
   * Compile a loaded {@link WorkflowHandle} into a {@link RuntimeWorkflow}.
   * Required for `startFromFile` when the WORKFLOW.md contains declarative
   * tool/map/parallel/etc steps; omitted/unsupported workflows return an error.
   */
  compileWorkflow?: (handle: WorkflowHandle) => RuntimeWorkflow | Promise<RuntimeWorkflow>
}): WorkflowRunner {
  const { registry, sessionEvents, resolveAgentAdapter, compileWorkflow } = opts
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
          ...(opts.resolveSandboxProvider
            ? { resolveSandboxProvider: opts.resolveSandboxProvider }
            : {}),
        },
      )

      const cache = input.cacheKey ? createFileStepCache(input.cacheKey) : undefined

      void executeRunWorkflow(state, workflow, agents, abort.signal, cache, input.cacheKey).then(() => {
        persist()
      })

      return run
    },

    startFromFile: async (args) => {
      if (!compileWorkflow) {
        throw new Error(
          "workflow file execution requires a compileWorkflow callback to be configured on the runner",
        )
      }
      const handle = await loadWorkflowHandle(args.path)
      const workflow = await compileWorkflow(handle)
      const fileStages = runtimeWorkflowToStages(workflow)
      const runId = `wfrun_${randomUUID()}`
      const run: WorkflowRun = {
        runId,
        workflowId: handle.id,
        status: "running",
        startedAt: new Date().toISOString(),
        stages: fileStages.map((stage, si) => ({
          index: si,
          ...(stage.label !== undefined ? { label: stage.label } : {}),
          status: "pending" as const,
          steps: stage.steps.map((s, i) => ({
            index: i,
            label: s.label,
            status: "pending" as const,
          })),
        })),
      }
      const abort = new AbortController()
      const state: RunState = {
        run,
        cancelled: false,
        abort,
        stages: fileStages,
        ...(args.cwd !== undefined ? { cwd: args.cwd } : {}),
        ...(args.workspaceSlug !== undefined ? { workspaceSlug: args.workspaceSlug } : {}),
      }
      runs.set(runId, state)
      persist()

      const agents = new SessionsRegistryAgentHost(
        registry,
        sessionEvents,
        resolveAgentAdapter,
        {
          workspaceSlug: args.workspaceSlug,
          cwd: args.cwd,
          ...(opts.resolveSandboxProvider
            ? { resolveSandboxProvider: opts.resolveSandboxProvider }
            : {}),
        },
      )

      const cache = args.cacheKey ? createFileStepCache(args.cacheKey) : undefined

      void executeRunWorkflow(
        state,
        workflow,
        agents,
        abort.signal,
        cache,
        args.cacheKey,
        args.input,
      ).then(() => {
        persist()
      })

      return run
    },

    status: (runId) => runs.get(runId)?.run,

    list: () => Array.from(runs.values()).map(s => s.run),

    // No-op today: `pendingResolve` is never set (escalate fails fast — see
    // RunState.pendingResolve). Retained for the durable suspend/resume
    // follow-up so the interface stays stable for existing callers.
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