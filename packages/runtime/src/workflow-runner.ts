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
import { buildAgentStep, runWorkflow } from "@agentproto/workflow-runtime"
import type { AgentSandboxRef, ApprovalDecision, Bindings, GateReportEvent, RuntimeWorkflow } from "@agentproto/workflow-runtime"
import type { StepCache } from "@agentproto/workflow-runtime"
import { loadWorkflowHandle } from "@agentproto/workflow-loader"
import type { WorkflowHandle } from "@agentproto/workflow"
import type { SessionsRegistry } from "./sessions.js"
import type { SessionEventBus } from "./session-event-bus.js"
import type { AgentAdapterResolver } from "./http-server.js"
import type { SandboxProviderResolver } from "./sandbox-adapters.js"
import type { WebhookNotifier } from "./webhook-notifier.js"
import type { RoutinePolicy, RoutineStepState } from "./step-run-types.js"
import { SessionsRegistryAgentHost } from "./sessions-registry-agent-host.js"
import { createFileStepCache } from "./workflow-step-cache.js"
import { appendAppStateEvent } from "./app-state.js"
import type { AppStateEventInput } from "./app-state.js"
import type { AppRegistry, InstalledApp } from "./app-registry.js"

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
  | "awaiting-approval"
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
  /** App provenance — set when the run was started on behalf of an
   *  installed app (explicit input, or the workflow id is owned by exactly
   *  one installed app per the registry). Drives the app state ledger
   *  appends in `executeRunWorkflow` (see `createLedgerAppender`). */
  appId?: string
  /** The app_run this run belongs to, when started through an app. */
  appRunId?: string
  /** Optional ledger `item` — stamped on EVERY app-ledger event this run
   *  appends, scoping them to one sub-key inside each stage (e.g. the map
   *  item or entity the run processes). */
  item?: string
  /** Set while the run is parked at a `kind: "approval"` step (status
   *  "awaiting-approval") — the human-in-the-loop inbox entry. Cleared on
   *  decision; survives a daemon restart (see loadRuns). */
  awaitingApproval?: {
    approvalId: string
    stepId: string
    prompt: string
    since: string
  }
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
    /** App provenance — the installed app this run belongs to. Omit to let
     *  the runner resolve it from the registry (workflow id owned by exactly
     *  one installed app). */
    appId?: string
    /** The app_run this run belongs to, when started through an app. */
    appRunId?: string
    /** Ledger `item` stamped on every ledger event this run appends. */
    item?: string
  }): Promise<WorkflowRun>

  startFromFile(input: {
    path: string
    input?: unknown
    cwd?: string
    workspaceSlug?: string
    cacheKey?: string
    /** App provenance — same resolution as `start`. */
    appId?: string
    appRunId?: string
    item?: string
  }): Promise<WorkflowRun>

  status(runId: string): WorkflowRun | undefined
  list(): WorkflowRun[]

  resolve(runId: string, stageIndex: number, stepIndex: number, response: string): void

  /** Resolve a `kind: "approval"` step's parked human decision (the
   *  "awaiting-approval" inbox). `who` records who decided (e.g. "jeremy");
   *  `approvalId`, when given, must match the parked request. */
  resolveApproval(
    runId: string,
    input: { approvalId?: string; approved: boolean; who: string; note?: string },
  ): { ok: true } | { ok: false; error: "run_not_found" | "not_awaiting_approval" | "approval_id_mismatch"; message: string }

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
   * Set while a step's `escalate` policy is suspended (`run.status ===
   * "awaiting-input"`), waiting for an external `resolve()` call —
   * `onEscalate` (below) fills this in and awaits its promise;
   * `WorkflowRunner.resolve()` fulfils it.
   */
  pendingResolve?: { stageIndex: number; stepIndex: number; resolver: (response: string) => void }
  /**
   * Set while a `kind: "approval"` step is parked (run.status ===
   * "awaiting-approval"), waiting for a human decision through
   * `WorkflowRunner.resolveApproval()`. `approvalId` ties the parked entry
   * to the run's `awaitingApproval` record across a daemon restart.
   */
  pendingApproval?: { approvalId: string; resolve: (decision: ApprovalDecision) => void }
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
        buildAgentStep(step.label, {
          prompt: (b: Bindings) => {
            const base = step.prompt ?? ""
            // Inject previous steps' text output into the prompt context
            const prevTexts: string[] = []
            if (b.steps && typeof b.steps === "object") {
              for (const [id, val] of Object.entries(b.steps as Record<string, unknown>)) {
                if (val && typeof val === "object" && "text" in val) {
                  const text = (val as { text?: string }).text
                  if (text) prevTexts.push(`[Output from step "${id}"]\n${text}`)
                }
              }
            }
            if (prevTexts.length > 0) return `${prevTexts.join("\n\n")}\n\n---\n\n${base}`
            return base
          },
          ...(step.adapter !== undefined ? { adapter: step.adapter } : {}),
          ...(step.sessionRef !== undefined ? { sessionRef: step.sessionRef } : {}),
          ...(step.sandbox !== undefined ? { sandbox: step.sandbox } : {}),
          ...(step.cacheable ? { cacheable: true } : {}),
          policy: step.policy,
        }),
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
    } else if (step.kind === "gate") {
      // No agent session — a `kind: "gate"` step is a subprocess check
      // (AIP-15 P3), not a spawn. Explicit branch (rather than falling
      // through the chain) so this stays true if a future kind reuses the
      // "no session" default.
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
    // WP-S: a run parked awaiting a human approval is NOT failed on reload —
    // its `awaitingApproval` record is durable. The runner re-registers the
    // pending item below so the decision is still taken and ledgered (the
    // run's in-flight execution itself can't resume; see the reload resolver).
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

// ── Escalate suspend/resume ───────────────────────────────────────────

/** Locate a step by label across a run's stages — `-1, -1` when not found
 *  (e.g. `stepId` is undefined because the session wasn't spawned by a
 *  labelled step). */
function findStepPosition(
  stages: readonly WorkflowStageState[],
  label: string | undefined,
): { stageIndex: number; stepIndex: number } {
  if (label !== undefined) {
    for (let si = 0; si < stages.length; si++) {
      const stepIndex = stages[si]!.steps.findIndex(s => s.label === label)
      if (stepIndex !== -1) return { stageIndex: si, stepIndex }
    }
  }
  return { stageIndex: -1, stepIndex: -1 }
}

/**
 * Build the `onEscalate` handler `SessionsRegistryAgentHost` calls instead of
 * failing an `escalate`-policy step fast: marks the run `awaiting-input`,
 * parks a resolver on `state.pendingResolve` for `WorkflowRunner.resolve()`
 * to fulfil, and times out the same way the retired RoutineRunner engine did.
 */
function createOnEscalate(
  state: RunState,
  persist: () => void,
): (
  sessionId: string,
  policy: Extract<RoutinePolicy, { awaiting: "escalate" }>,
  stepId: string | undefined,
) => Promise<string> {
  return async (sessionId, policy, stepId) => {
    const { stageIndex, stepIndex } = findStepPosition(state.run.stages, stepId)
    state.run.status = "awaiting-input"
    persist()
    try {
      return await new Promise<string>((resolve, reject) => {
        const timeoutMs = policy.timeoutMs ?? 300_000
        const timer = setTimeout(() => {
          state.pendingResolve = undefined
          reject(new Error(`step '${stepId ?? sessionId}' escalate timeout`))
        }, timeoutMs)
        state.pendingResolve = {
          stageIndex,
          stepIndex,
          resolver: (response: string) => {
            clearTimeout(timer)
            state.pendingResolve = undefined
            resolve(response)
          },
        }
      })
    } finally {
      if (state.run.status === "awaiting-input") state.run.status = "running"
      persist()
    }
  }
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

// ── App state ledger bridge (WP-Q) ───────────────────────────────────

/**
 * Resolve an app run's provenance: an explicit `appId` wins; otherwise the
 * workflow id is looked up across the installed-app registry and adopted
 * only when EXACTLY ONE installed app owns it (ambiguous/unknown ids stay
 * unattributed — a generic workflow id like "review" must not silently pin
 * itself to whichever app happens to be installed).
 */
function resolveAppProvenance(
  appRegistry: Pick<AppRegistry, "getApp" | "listApps"> | undefined,
  workflowId: string,
  explicit: { appId?: string; appRunId?: string; item?: string },
): { appId?: string; appRunId?: string; item?: string } {
  if (explicit.appId !== undefined || appRegistry === undefined) return explicit
  const owners = appRegistry.listApps().filter(a => a.workflows.some(w => w.id === workflowId))
  if (owners.length !== 1) return explicit
  return { ...explicit, appId: owners[0]!.appId }
}

/** Static step-kind lookup for the `stage-started` payload — walks the
 *  compiled step graph by id. `map`/`pipeline` bodies are runtime
 *  functions with no static step list (see `collectAgentSteps`), so steps
 *  they produce resolve to `undefined` and the `kind` key is omitted. */
function findStepKind(steps: readonly RuntimeStep[], id: string): string | undefined {
  for (const step of steps) {
    if (step.id === id) return step.kind
    if (step.kind === "parallel") {
      for (const branch of step.branches) {
        const found = findStepKind(branch.steps, id)
        if (found !== undefined) return found
      }
    } else if (step.kind === "group") {
      const found = findStepKind(step.steps, id)
      if (found !== undefined) return found
    } else if (step.kind === "branch") {
      const thenKind = findStepKind(step.then, id)
      if (thenKind !== undefined) return thenKind
      if (step.otherwise) {
        const elseKind = findStepKind(step.otherwise, id)
        if (elseKind !== undefined) return elseKind
      }
    } else if (step.kind === "loop") {
      const found = findStepKind(step.body, id)
      if (found !== undefined) return found
    } else if (step.kind === "subworkflow") {
      const found = findStepKind(step.workflow.steps, id)
      if (found !== undefined) return found
    }
  }
  return undefined
}

/**
 * Best-effort app state ledger appender for one workflow run — the
 * runner-written side of the trame rule ("state is written only by the
 * daemon's ledger from gate results and approvals"): every append is
 * serialized through a promise chain so ledger order matches emission
 * order, and ANY failure (unknown app, invalid payload, fs error) logs a
 * warning and never fails the run.
 */
function createLedgerAppender(
  app: Pick<InstalledApp, "dir" | "dataDir">,
  appRunId: string | undefined,
  runId: string,
  item: string | undefined,
): {
  append: (input: Omit<AppStateEventInput, "by" | "appRunId" | "item"> & { by?: AppStateEventInput["by"] }) => void
  flush: () => Promise<void>
} {
  let chain: Promise<void> = Promise.resolve()
  const append = (
    input: Omit<AppStateEventInput, "by" | "appRunId" | "item"> & { by?: AppStateEventInput["by"] },
  ): void => {
    chain = chain
      .then(async () => {
        await appendAppStateEvent(app, {
          ...input,
          by: input.by ?? "runner",
          ...(appRunId !== undefined ? { appRunId } : {}),
          ...(item !== undefined ? { item } : {}),
        })
      })
      .catch((err: unknown) => {
        console.warn(
          `[workflow-runner] app ledger append failed for run ${runId}: ${err instanceof Error ? err.message : String(err)}`,
        )
      })
  }
  return { append, flush: () => chain }
}

// ── Background execution ─────────────────────────────────────────────

async function executeRunWorkflow(
  state: RunState,
  runtimeWf: RuntimeWorkflow,
  agents: SessionsRegistryAgentHost,
  signal: AbortSignal,
  sessionEvents: SessionEventBus,
  cache?: StepCache,
  cacheKey?: string,
  input?: unknown,
  persist?: () => void,
  appRegistry?: Pick<AppRegistry, "getApp" | "listApps">,
): Promise<void> {
  // App state ledger bridge (WP-Q): when the run belongs to an installed
  // app, mirror the run's progress onto the app's ledger with `by: "runner"`
  // — stage-started / gate-report / stage-done / blocked — so the app's
  // stage board (`app_state_get`) reflects reality without any agent
  // self-certifying state. Best-effort: failures warn, never fail the run.
  const ledgerApp = state.run.appId !== undefined ? appRegistry?.getApp(state.run.appId) : undefined
  const ledger = ledgerApp
    ? createLedgerAppender(ledgerApp, state.run.appRunId, state.run.runId, state.run.item)
    : undefined
  const ledgerAppend = ledger?.append.bind(ledger)
  // Steps that started but never completed — the blocked-event candidates
  // when the run throws (step failed / gate retries exhausted / aborted).
  const runningSteps = new Set<string>()

  try {
    await runWorkflow({
      workflow: runtimeWf,
      agents,
      signal,
      cwd: state.cwd,
      workspaceSlug: state.workspaceSlug,
      input,
      ...(cache ? { cache, cacheKey } : {}),
      // WP-S — human-resolved approval steps: a `kind: "approval"` step parks
      // the run as "awaiting-approval" with a pending inbox entry, instead of
      // the engine's silent auto-approve. A human answers through
      // `resolveApproval` (wired to `workflow_escalation_resolve`'s approval
      // form); the decision lands on the app ledger (`kind: "approval"`,
      // `by: "human"`) per the trame rule.
      approve: (req) =>
        new Promise<boolean | ApprovalDecision>((resolve) => {
          const approvalId = `wfappr_${randomUUID()}`
          const requestedAt = new Date().toISOString()
          state.run.status = "awaiting-approval"
          state.run.awaitingApproval = {
            approvalId,
            stepId: req.stepId,
            prompt: req.prompt,
            since: requestedAt,
          }
          persist?.()
          sessionEvents.emit({
            type: "workflow:approval-requested",
            runId: state.run.runId,
            approvalId,
            stepId: req.stepId,
            prompt: req.prompt,
            approvers: [...req.approvers],
            ...(req.artifacts !== undefined ? { artifacts: [...req.artifacts] } : {}),
            requestedAt,
            ts: requestedAt,
          })

          let timer: ReturnType<typeof setTimeout> | undefined
          const onAbort = (): void => {
            finish({ approved: false, who: "cancelled" })
          }
          const finish = (decision: ApprovalDecision): void => {
            if (timer !== undefined) clearTimeout(timer)
            signal.removeEventListener("abort", onAbort)
            state.pendingApproval = undefined
            if (state.run.awaitingApproval?.approvalId === approvalId) {
              state.run.awaitingApproval = undefined
            }
            if (state.run.status === "awaiting-approval") state.run.status = "running"
            persist?.()
            const ts = new Date().toISOString()
            sessionEvents.emit({
              type: "workflow:approval-resolved",
              runId: state.run.runId,
              approvalId,
              stepId: req.stepId,
              approved: decision.approved,
              who: decision.who,
              ...(decision.note !== undefined ? { note: decision.note } : {}),
              ts,
            })
            // The trame rule: the human decision — not the agent — writes the
            // approval onto the ledger. Daemon-side verdicts (timeout, cancel)
            // are not human decisions and carry `by: "system"`.
            ledgerAppend?.({
              stage: req.stepId,
              kind: "approval",
              by: decision.who === "timeout" || decision.who === "cancelled" ? "system" : "human",
              payload: {
                approved: decision.approved,
                who: decision.who,
                ...(decision.note !== undefined ? { note: decision.note } : {}),
                runId: state.run.runId,
              },
            })
            resolve(decision)
          }
          if (req.timeoutMs !== undefined) {
            timer = setTimeout(() => {
              finish({ approved: false, who: "timeout" })
            }, req.timeoutMs)
          }
          signal.addEventListener("abort", onAbort, { once: true })
          state.pendingApproval = { approvalId, resolve: finish }
        }),
      onGateReport: (ev: GateReportEvent) => {
        sessionEvents.emit({
          type: "workflow:gate-report",
          runId: state.run.runId,
          stepId: ev.stepId,
          ok: ev.ok,
          exitCode: ev.exitCode,
          report: ev.report,
          attempt: ev.attempt,
          ts: new Date().toISOString(),
        })
        ledgerAppend?.({
          stage: ev.stepId,
          kind: "gate-report",
          payload: {
            ok: ev.ok,
            exitCode: ev.exitCode,
            ...(ev.report !== undefined ? { report: ev.report } : {}),
            attempt: ev.attempt,
            runId: state.run.runId,
          },
        })
        // Best-effort: keep a matching WorkflowStageState row (if one is
        // ever surfaced for a gate step id) in sync too.
        for (const stage of state.run.stages) {
          const step = stage.steps.find((s) => s.label === ev.stepId)
          if (step) {
            step.gateReport = { ok: ev.ok, exitCode: ev.exitCode, report: ev.report, attempt: ev.attempt }
            persist?.()
            break
          }
        }
      },
      onStepStart: (stepId) => {
        runningSteps.add(stepId)
        ledgerAppend?.({
          stage: stepId,
          kind: "stage-started",
          payload: {
            runId: state.run.runId,
            ...(() => {
              const kind = findStepKind(runtimeWf.steps, stepId)
              return kind !== undefined ? { kind } : {}
            })(),
          },
        })
        // Find and mark the step as running
        for (const stage of state.run.stages) {
          const step = stage.steps.find((s) => s.label === stepId)
          if (step) {
            if (step.status === "pending") {
              step.status = "running"
              step.startedAt = new Date().toISOString()
            }
            // Update stage status if it's still pending
            if (stage.status === "pending") {
              stage.status = "running"
            }
            persist?.()
            break
          }
        }
      },
      onStepComplete: (stepId, output) => {
        runningSteps.delete(stepId)
        // Find and mark the step as done
        let doneStep: (typeof state.run.stages)[number]["steps"][number] | undefined
        for (const stage of state.run.stages) {
          const step = stage.steps.find((s) => s.label === stepId)
          if (step) {
            doneStep = step
            step.status = "done"
            step.endedAt = new Date().toISOString()
            // Extract sessionId from output if present
            if (output && typeof output === "object" && "sessionId" in output) {
              step.sessionId = (output as { sessionId: string }).sessionId
            }
            // Check if all steps in stage are done
            const allDone = stage.steps.every((s) => s.status === "done")
            if (allDone) {
              stage.status = "done"
            }
            persist?.()
            break
          }
        }
        // Ledger append regardless of whether the step is tracked in
        // `run.stages` — gate steps have no tracked row (collectAgentSteps
        // skips them) but must still reach the app's stage board.
        ledgerAppend?.({
          stage: stepId,
          kind: "stage-done",
          payload: {
            runId: state.run.runId,
            ...(() => {
              if (doneStep?.startedAt === undefined || doneStep?.endedAt === undefined) return {}
              const durationMs = Date.parse(doneStep.endedAt) - Date.parse(doneStep.startedAt)
              return Number.isFinite(durationMs) && durationMs >= 0 ? { durationMs } : {}
            })(),
          },
        })
      },
    })

    // Success — mark all stages/steps done (fallback for any missed).
    for (const stage of state.run.stages) {
      if (stage.status !== "done") stage.status = "done"
      for (const step of stage.steps) {
        if (step.status !== "done") {
          step.status = "done"
          step.endedAt = new Date().toISOString()
        }
      }
    }
    state.run.status = "done"
    state.run.endedAt = new Date().toISOString()

    const sessionIds = fillStepStates(state.run.stages, state.stages, agents)
    if (sessionIds.length > 0) state.run.result = { sessionIds }
  } catch (err) {
    const blockedReason = signal.aborted ? "run aborted" : err instanceof Error ? err.message : String(err)
    for (const stepId of runningSteps) {
      ledgerAppend?.({
        stage: stepId,
        kind: "blocked",
        payload: { reason: blockedReason, runId: state.run.runId },
      })
    }
    runningSteps.clear()
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

  // Drain the ledger append queue before the run's terminal state is
  // persisted, so the file reflects the run by the time status() flips.
  if (ledger) await ledger.flush()

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
  /**
   * Installed-app registry — enables the app state ledger bridge: when a
   * run's workflow id is owned by exactly one installed app (or `appId` is
   * passed explicitly), the runner mirrors stage progress onto that app's
   * ledger (`<dataDir>/state/events.jsonl`, `by: "runner"`). Omitted ⇒ no
   * ledger writes, behaviour unchanged.
   */
  appRegistry?: Pick<AppRegistry, "getApp" | "listApps">
}): WorkflowRunner {
  const { registry, sessionEvents, resolveAgentAdapter, compileWorkflow } = opts
  const persistPath = opts.persistPath ?? DEFAULT_PERSIST_PATH()
  const shouldPersist = opts.persist ?? (opts.persistPath !== undefined)

  const runs = shouldPersist ? loadRuns(persistPath) : new Map<string, RunState>()

  const persist = (): void => {
    if (shouldPersist) saveRuns(runs, persistPath)
  }

  // ── Reload re-registration (WP-S restart safety) ────────────────────
  //
  // A run parked at "awaiting-approval" survives the restart with its
  // `awaitingApproval` record intact. The live approve hook died with the
  // old process, so re-register a pending item here: a decision still
  // resolves (emit + ledger `approval` event, exactly once — the live hook
  // is gone, so no double write), but the run itself can't resume execution
  // and is marked failed with a clear reason.
  const reRegisterReloadedApprovals = (): void => {
    for (const state of runs.values()) {
      const run = state.run
      const aa = run.awaitingApproval
      if (run.status !== "awaiting-approval" || !aa) continue
      const resolveAfterRestart = (decision: ApprovalDecision): void => {
        // Only the FIRST decision wins — the pending entry is cleared before
        // anything else runs.
        if (state.pendingApproval?.approvalId !== aa.approvalId) return
        state.pendingApproval = undefined
        run.awaitingApproval = undefined
        run.status = "failed"
        run.error =
          "approval resolved after daemon restart — the run's execution could not resume"
        run.endedAt = run.endedAt ?? new Date().toISOString()
        persist()
        sessionEvents.emit({
          type: "workflow:approval-resolved",
          runId: run.runId,
          approvalId: aa.approvalId,
          stepId: aa.stepId,
          approved: decision.approved,
          who: decision.who,
          ...(decision.note !== undefined ? { note: decision.note } : {}),
          ts: new Date().toISOString(),
        })
        if (run.appId !== undefined && opts.appRegistry) {
          const app = opts.appRegistry.getApp(run.appId)
          if (app) {
            const ledger = createLedgerAppender(app, run.appRunId, run.runId, run.item)
            ledger.append({
              stage: aa.stepId,
              kind: "approval",
              by: decision.who === "timeout" || decision.who === "cancelled" ? "system" : "human",
              payload: {
                approved: decision.approved,
                who: decision.who,
                ...(decision.note !== undefined ? { note: decision.note } : {}),
                runId: run.runId,
              },
            })
            void ledger.flush().catch((err: unknown) => {
              console.warn(
                `[workflow-runner] post-restart approval ledger append failed for run ${run.runId}: ${err instanceof Error ? err.message : String(err)}`,
              )
            })
          }
        }
      }
      state.pendingApproval = { approvalId: aa.approvalId, resolve: resolveAfterRestart }
    }
  }
  reRegisterReloadedApprovals()

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
        ...resolveAppProvenance(opts.appRegistry, input.workflowId, {
          ...(input.appId !== undefined ? { appId: input.appId } : {}),
          ...(input.appRunId !== undefined ? { appRunId: input.appRunId } : {}),
          ...(input.item !== undefined ? { item: input.item } : {}),
        }),
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
          onEscalate: createOnEscalate(state, persist),
          ...(opts.resolveSandboxProvider
            ? { resolveSandboxProvider: opts.resolveSandboxProvider }
            : {}),
        },
      )

      const cache = input.cacheKey ? createFileStepCache(input.cacheKey) : undefined

      void executeRunWorkflow(state, workflow, agents, abort.signal, sessionEvents, cache, input.cacheKey, undefined, persist, opts.appRegistry).then(() => {
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
        ...resolveAppProvenance(opts.appRegistry, handle.id, {
          ...(args.appId !== undefined ? { appId: args.appId } : {}),
          ...(args.appRunId !== undefined ? { appRunId: args.appRunId } : {}),
          ...(args.item !== undefined ? { item: args.item } : {}),
        }),
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
          onEscalate: createOnEscalate(state, persist),
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
        sessionEvents,
        cache,
        args.cacheKey,
        args.input,
        persist,
        opts.appRegistry,
      ).then(() => {
        persist()
      })

      return run
    },

    status: (runId) => runs.get(runId)?.run,

    list: () => Array.from(runs.values()).map(s => s.run),

    // Fulfils the promise `onEscalate` (createOnEscalate) is awaiting for a
    // suspended `escalate`-policy step — a no-op if no step at
    // (stageIndex, stepIndex) is currently escalated.
    resolve: (runId, stageIndex, stepIndex, response) => {
      const state = runs.get(runId)
      if (!state) return
      const pr = state.pendingResolve
      if (pr && pr.stageIndex === stageIndex && pr.stepIndex === stepIndex) {
        pr.resolver(response)
      }
    },

    // Resolve a parked `kind: "approval"` decision (WP-S). Works both for a
    // live run (the approve hook's resolver) and for a run re-registered
    // after a daemon restart.
    resolveApproval: (runId, input) => {
      const state = runs.get(runId)
      if (!state) {
        return {
          ok: false,
          error: "run_not_found",
          message: `no workflow run "${runId}"`,
        }
      }
      const pa = state.pendingApproval
      if (!pa) {
        return {
          ok: false,
          error: "not_awaiting_approval",
          message: `run "${runId}" is not awaiting an approval (status: ${state.run.status})`,
        }
      }
      if (input.approvalId !== undefined && input.approvalId !== pa.approvalId) {
        return {
          ok: false,
          error: "approval_id_mismatch",
          message: `run "${runId}" is awaiting approval "${pa.approvalId}", not "${input.approvalId}"`,
        }
      }
      pa.resolve({
        approved: input.approved,
        who: input.who,
        ...(input.note !== undefined ? { note: input.note } : {}),
      })
      return { ok: true }
    },

    cancel: (runId) => {
      const state = runs.get(runId)
      if (!state) return
      state.cancelled = true
      state.abort.abort()
      if (state.run.status === "running" || state.run.status === "awaiting-input" || state.run.status === "awaiting-approval") {
        state.run.status = "cancelled"
        state.run.endedAt = new Date().toISOString()
        persist()
      }
    },
  }
}