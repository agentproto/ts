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
 * "interrupted by daemon restart" — EXCEPT a run parked at a
 * `kind: "suspend"` step (status "awaiting-input" with a durable
 * `awaitingSuspend` record), which stays suspended and is re-registered so
 * a matching `resumeSuspend` still lands (AIP-15 conformance rule 7).
 *
 * Persistence opt-in: disabled by default (persist defaults to false when
 * no persistPath is supplied) so unit tests never touch ~/.agentproto/.
 */

import { randomUUID } from "node:crypto"
import { homedir } from "node:os"
import { join, dirname } from "node:path"
import { mkdirSync, readFileSync, existsSync, writeFileSync, renameSync } from "node:fs"
import { buildAgentStep, runWorkflow, validateWorkflowInput, validateAgainstJsonSchema, StepOutcomeError } from "@agentproto/workflow-runtime"
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
import { createRunEventLog, readRunEvents, DEFAULT_RUNS_ROOT, type RunEventLog, type RunEventEnvelope } from "./run-event-log.js"
import { loadWorkspacesConfig, getActiveWorkspace } from "./workspaces-config.js"

// ── Public types ─────────────────────────────────────────────────────

export interface WorkflowStep {
  label: string
  /** Prompt to send to the agent. Omit to just spawn/reuse and wait. */
  prompt?: string
  /** Adapter slug for spawning a NEW session. Omit to reuse a prior session. */
  adapter?: string
  /** Model id override forwarded to the spawn — same semantics as
   *  `agent_start.model`. Omitted ⇒ unchanged behaviour (the adapter keeps
   *  its default). Only meaningful with `adapter`. */
  model?: string
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
  /** AIP-58 §10 error code for `error`, when the failure has one — today
   *  only `startFromFile`'s pre-dispatch input-validation rejection sets
   *  this (`"invalid-input"`). Absent on every other failure path. */
  errorCode?: string
  result?: { sessionIds: string[] }
  /** F25: the working directory agent steps (and the run itself) spawn
   *  under — the caller's explicit `cwd` when given, else `startFromFile`'s
   *  resolved default (owning app's root > daemon's active workspace >
   *  process cwd, never a bare "/"; see `resolveRunCwd`). Recorded here even
   *  when defaulted, so a run's actual spawn location is never silently
   *  invisible. Only set by `startFromFile` today — `start` (the
   *  `WorkflowStage[]` path) is unaffected by this default. */
  cwd?: string
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
  /** Set while the run is parked awaiting EITHER a `kind: "suspend"` step's
   *  external event (`on` set, per AIP-15 conformance rule 7) OR an
   *  agent-backed step's AIP-58 §3(a) `run.requestInput` signal (`reason:
   *  "input-required"` + `prompt`/`schema?`, mirroring AIP-58's
   *  `StepRecord.suspend` exactly — status "awaiting-input" either way).
   *  Cleared on resume; survives a daemon restart (see loadRuns + the
   *  reload re-registration). */
  awaitingSuspend?: {
    stepId: string
    since: string
    on?: string[]
    reason?: "input-required"
    prompt?: string
    schema?: Record<string, unknown>
  }
  /** AIP-58 §2 "a `running` run MUST have a live owner" — a lease with a
   *  heartbeat. Set at dispatch, renewed on a timer while `executeRunWorkflow`
   *  is in flight, persisted with every renewal. `sweep()` marks the run
   *  `failed { code: "orphaned" }` once `heartbeatAt` is older than the
   *  runner's `leaseTtlMs` — the case a host restart doesn't catch (the
   *  owning process/worker died without the DAEMON itself restarting). Only
   *  meaningful while `status === "running"`; cleared on every terminal
   *  transition and on reload (a fresh process is a fresh owner). */
  lease?: {
    ownerId: string
    heartbeatAt: string
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

  /** AIP-58 §5/§9 `run.events` — events with `seq > sinceSeq`, in order.
   *  `undefined` when `runId` is unknown; an empty array is a known run
   *  with nothing new to report. Reads straight from the on-disk log, so it
   *  works for a run from a prior daemon process too. */
  events(runId: string, sinceSeq?: number): RunEventEnvelope[] | undefined

  /** AIP-58 §2 owner-liveness sweep: marks every `running` run whose lease
   *  has expired (`now - lease.heartbeatAt > leaseTtlMs`, no live renewal —
   *  see `WorkflowRun.lease`) `failed { code: "orphaned" }`. A conservative
   *  TTL, not a restart check (that's `loadRuns`'s job) — this is what
   *  catches an owner that died WITHOUT the daemon itself restarting.
   *  `now` defaults to the real clock; a caller (or a test) MAY pass a fixed
   *  one instead of waiting on a real timer. Callable directly (tests) or on
   *  a caller-owned interval (the daemon composition root); this runner
   *  does not schedule it on its own. */
  sweep(now?: Date): { orphaned: string[] }

  resolve(runId: string, stageIndex: number, stepIndex: number, response: string): void

  /** Resolve a `kind: "approval"` step's parked human decision (the
   *  "awaiting-approval" inbox). `who` records who decided (e.g. "jeremy");
   *  `approvalId`, when given, must match the parked request. */
  resolveApproval(
    runId: string,
    input: { approvalId?: string; approved: boolean; who: string; note?: string },
  ): { ok: true } | { ok: false; error: "run_not_found" | "not_awaiting_approval" | "approval_id_mismatch"; message: string }

  /** Resolve a parked `kind: "suspend"` step OR an AIP-58 §3(a)
   *  `run.requestInput` suspend (AIP-15 rule 7 / AIP-58 §3). Works both for
   *  a live run and for a run re-registered after a daemon restart (in
   *  which case the recorded decision lands but the run's execution cannot
   *  resume). `stepId`, when given, must match the parked step. When the
   *  parked record carries a `schema` (the §3(a) case), `payload` MUST
   *  validate against it BEFORE the transition happens — an invalid
   *  payload is rejected and the run stays suspended. */
  resumeSuspend(
    runId: string,
    input: { stepId?: string; payload?: unknown },
  ):
    | { ok: true }
    | {
        ok: false
        error: "run_not_found" | "not_awaiting_suspend" | "step_id_mismatch" | "invalid_payload"
        message: string
      }

  /**
   * AIP-58 §9 `run.requestInput`, called by the executing step's OWN
   * session (via the `run_request_input` MCP tool) — records the signal
   * against whichever run/step spawned `sessionId`, resolved from this
   * runner's own spawn bookkeeping. Does not end the turn. A session not
   * owned by any running workflow step is a tool error with no side
   * effect.
   */
  recordInputRequest(
    sessionId: string,
    req: { prompt: string; schema?: Record<string, unknown> },
  ): { ok: true; runId: string; stepId: string } | { ok: false; error: "session_not_in_workflow_step" }

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
  /**
   * Set while a `kind: "suspend"` step is parked (run.status ===
   * "awaiting-input"), waiting for an external event through
   * `WorkflowRunner.resumeSuspend()`. Survives a daemon restart via the
   * run's durable `awaitingSuspend` record.
   */
  pendingSuspend?: { stepId: string; resolve: (payload: unknown) => void }
  /** AIP-58 §5 per-run event log — undefined when persistence is off (tests). */
  eventLog?: RunEventLog
  /** AIP-58 §2 lease renewal timer, alive for as long as this process is
   *  actively driving the run (see `executeRunWorkflow`). `sweep()` clears
   *  it when orphaning a run so a heartbeat that fires just afterwards can't
   *  resurrect a fresh `lease` on an already-`failed` record. */
  heartbeatTimer?: ReturnType<typeof setInterval>
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
          ...(step.model !== undefined ? { model: step.model } : {}),
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
// `startFromFile` wraps a compiled WORKFLOW.md in a single outer run.
// Historically only `kind: "agent"` steps were surfaced here (everything
// else showed up as one opaque "workflow" step — F28), because the
// workflow-runtime's AgentSessionHost stores spawned sessions under the
// *inner* step ids (e.g. "review") and only agent steps have a session to
// resolve. AIP-58 §5 wants every REAL step visible, session or not: walk
// the compiled runtime workflow for every statically-enumerable leaf step
// (agent/tool/gate/transform/approval/suspend) so `workflow_status` shows
// fetch/dedup/clean, not "workflow". A `map`/`pipeline` body's per-item
// steps can't be enumerated here (the item list is only known at runtime) —
// those are discovered dynamically as they start (see `onStepStart` below),
// reported under `<bodyStepId>[<index>]` (see `withIndexedHooks` in
// `@agentproto/workflow-runtime`'s run-workflow.ts).

type RuntimeStep = RuntimeWorkflow["steps"][number]

interface CollectedStep {
  id: string
  adapter?: string
  sessionRef?: string
  /** Inside a `branch` arm — only runs if that arm is taken. */
  conditional: boolean
}

function collectStaticSteps(steps: readonly RuntimeStep[], conditional = false): CollectedStep[] {
  const collected: CollectedStep[] = []
  for (const step of steps) {
    if (step.kind === "agent") {
      const adapter = typeof step.adapter === "string" ? step.adapter : undefined
      collected.push({ id: step.id, adapter, sessionRef: step.sessionRef, conditional })
    } else if (step.kind === "parallel") {
      for (const branch of step.branches) collected.push(...collectStaticSteps(branch.steps, conditional))
    } else if (step.kind === "group") {
      collected.push(...collectStaticSteps(step.steps, conditional))
    } else if (step.kind === "map" || step.kind === "pipeline") {
      // Dynamic — the item list (and so the per-item step ids) is only known
      // once this step actually runs. See the module comment above.
    } else if (step.kind === "branch") {
      collected.push(...collectStaticSteps(step.then, true))
      if (step.otherwise) collected.push(...collectStaticSteps(step.otherwise, true))
    } else if (step.kind === "loop") {
      collected.push(...collectStaticSteps(step.body, conditional))
    } else if (step.kind === "subworkflow") {
      collected.push(...collectStaticSteps(step.workflow.steps, conditional))
    } else {
      // tool / gate / transform / approval / suspend — real, statically-known
      // leaf steps with no agent session of their own.
      collected.push({ id: step.id, conditional })
    }
  }
  return collected
}

/**
 * One synthetic stage whose steps are the workflow's statically-known leaf
 * steps, deduplicated by id (F31: the branch compiler copies a shared tail
 * into every arm, so the same id can appear once per arm).
 *
 * `includeConditional: false` (the `run.stages` projection) leaves out steps
 * that live only inside a `branch` arm — an arm that's never taken must not
 * show up as a step at all (F31: `skip-pdf` listed twice, never ran). Those
 * are discovered when they actually start, exactly like map items.
 * `includeConditional: true` (the step DEFS used for sessionId resolution)
 * keeps them, so a branch-arm step's `sessionRef` still resolves.
 */
function runtimeWorkflowToStages(
  workflow: RuntimeWorkflow,
  opts: { includeConditional?: boolean } = {},
): WorkflowStage[] {
  const all = collectStaticSteps(workflow.steps)
  const unconditional = new Set(all.filter(s => !s.conditional).map(s => s.id))
  const seen = new Set<string>()
  const steps = all.filter((s) => {
    if (seen.has(s.id)) return false
    if (opts.includeConditional !== true && !unconditional.has(s.id)) return false
    seen.add(s.id)
    return true
  })
  return [
    {
      steps: steps.map((a) => ({
        label: a.id,
        ...(a.adapter !== undefined ? { adapter: a.adapter } : {}),
        ...(a.sessionRef !== undefined ? { sessionRef: a.sessionRef } : {}),
      })),
    },
  ]
}

/** Map/pipeline item ids (`base[idx]`) don't appear in `defs` — recover the
 *  base step's def (for its `sessionRef`, if any) by stripping the suffix. */
const MAP_ITEM_ID_RE = /^(.*)\[\d+\]$/

/**
 * Every step id belonging to a COMPOSITE/control-flow kind
 * (parallel/group/branch/loop/map/pipeline/subworkflow) — `translateStages`'s
 * per-stage `kind: "parallel"` wrapper (id `stage-N`) for a `start()` call,
 * and `compileStepList`'s synthetic `kind: "group"` wrapper (id
 * `<id>__body`) for a multi-step map/pipeline body, both included. None of
 * these is "a real step" AIP-58 §5 cares about — the leaf steps inside them
 * each fire their own onStepStart/onStepComplete already (map/pipeline
 * items additionally indexed, `<id>[<idx>]`, by `withIndexedHooks` in
 * `@agentproto/workflow-runtime`) — so `onStepStart`/`onStepComplete` skip
 * any id in this set rather than recording a phantom extra row.
 */
function collectNonLeafStepIds(steps: readonly RuntimeStep[], acc: Set<string> = new Set()): Set<string> {
  for (const step of steps) {
    switch (step.kind) {
      case "parallel":
        acc.add(step.id)
        for (const branch of step.branches) collectNonLeafStepIds(branch.steps, acc)
        break
      case "group":
        acc.add(step.id)
        collectNonLeafStepIds(step.steps, acc)
        break
      case "map":
      case "pipeline":
        acc.add(step.id)
        break
      case "branch":
        acc.add(step.id)
        collectNonLeafStepIds(step.then, acc)
        if (step.otherwise) collectNonLeafStepIds(step.otherwise, acc)
        break
      case "loop":
        acc.add(step.id)
        collectNonLeafStepIds(step.body, acc)
        break
      case "subworkflow":
        acc.add(step.id)
        collectNonLeafStepIds(step.workflow.steps, acc)
        break
      default:
        break
    }
  }
  return acc
}

function findStepDef(defs: readonly WorkflowStage[], stepId: string): WorkflowStep | undefined {
  for (const def of defs) {
    const found = def.steps.find(s => s.label === stepId)
    if (found) return found
  }
  const m = MAP_ITEM_ID_RE.exec(stepId)
  return m ? findStepDef(defs, m[1]!) : undefined
}

// ── Factory ──────────────────────────────────────────────────────────

const DEFAULT_PERSIST_PATH = (): string =>
  join(homedir(), ".agentproto", "workflow-runs.json")

// AIP-58 §2 owner-liveness — see `createWorkflowRunner`'s `leaseTtlMs`/
// `heartbeatIntervalMs` doc comments for the rationale behind these values.
const DEFAULT_LEASE_TTL_MS = 60_000
const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000

// ── Persistence helpers (mirrors routine-runner.ts exactly) ──────────

function loadRuns(persistPath: string, runsRoot: string): Map<string, RunState> {
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
  let anyMarkedInterrupted = false
  for (const item of parsed) {
    if (!item || typeof item !== "object" || typeof (item as WorkflowRun).runId !== "string") continue
    const run = item as WorkflowRun
    // AIP-15 conformance rule 7 / AIP-58 §2 host-restart rule: a run parked
    // at a `kind: "suspend"` step carries a durable `awaitingSuspend` record
    // — keep it suspended so a matching resume can still land (the pending
    // entry is re-registered below). Any other in-flight run (running /
    // awaiting-input without a suspend record) is `failed { code:
    // "host-interrupted" }` — the daemon restarted while it was running and
    // it was not durably parked.
    const parkedAtSuspend = run.status === "awaiting-input" && run.awaitingSuspend !== undefined
    if (!parkedAtSuspend && (run.status === "running" || run.status === "awaiting-input")) {
      run.status = "failed"
      run.error = "interrupted by daemon restart"
      run.errorCode = "host-interrupted"
      run.endedAt = run.endedAt ?? new Date().toISOString()
      run.lease = undefined
      anyMarkedInterrupted = true
      createRunEventLog(run.runId, runsRoot).append({
        type: "run.failed",
        data: { code: "host-interrupted", message: run.error },
      })
    }
    // WP-S: a run parked awaiting a human approval is NOT failed on reload —
    // its `awaitingApproval` record is durable. The runner re-registers the
    // pending item below so the decision is still taken and ledgered (the
    // run's in-flight execution itself can't resume; see the reload resolver).
    result.set(run.runId, { run, cancelled: false, abort: new AbortController(), stages: [] })
  }
  // Persist the host-interrupted corrections immediately — a second restart
  // before anything else calls `persist()` must not re-derive/re-emit them.
  if (anyMarkedInterrupted) saveRuns(result, persistPath)
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
 *  labelled step). `stepIndex` is the step's stable `index` field, not its
 *  array position: `markStepStarted` reorders steps into execution order
 *  (F31), so the two can differ. */
function findStepPosition(
  stages: readonly WorkflowStageState[],
  label: string | undefined,
): { stageIndex: number; stepIndex: number } {
  if (label !== undefined) {
    for (let si = 0; si < stages.length; si++) {
      const step = stages[si]!.steps.find(s => s.label === label)
      if (step) return { stageIndex: si, stepIndex: step.index }
    }
  }
  return { stageIndex: -1, stepIndex: -1 }
}

/**
 * F31: a step that starts moves ahead of every still-pending step, so the
 * steps array reads in EXECUTION order (started steps in start order, then
 * the not-yet-started ones in declaration order) — not declaration order
 * with dynamically-discovered map items tacked on at the end. The step's
 * `index` stays what it was (its stable handle, see `findStepPosition`).
 */
function moveToExecutionOrder(stage: WorkflowStageState, step: RoutineStepState): void {
  const from = stage.steps.indexOf(step)
  if (from === -1) return
  const firstPending = stage.steps.findIndex(s => s !== step && s.status === "pending")
  if (firstPending === -1 || firstPending > from) return
  stage.steps.splice(from, 1)
  stage.steps.splice(firstPending, 0, step)
}

/**
 * F34: attach a spawned agent session to its step row the moment the host
 * labels it, so a RUNNING agent step exposes its sessionId (previously only
 * filled once the whole run ended). A map/pipeline item spawns under its
 * body step's plain id (`clean`), while its row is indexed (`clean[0]`) —
 * the first running item row without a session yet takes it (items start
 * before they spawn, in order).
 */
function attachStepSession(run: WorkflowRun, stepId: string, sessionId: string): boolean {
  for (const stage of run.stages) {
    const exact = stage.steps.find(s => s.label === stepId)
    if (exact) {
      exact.sessionId = sessionId
      return true
    }
  }
  for (const stage of run.stages) {
    const item = stage.steps.find(
      s =>
        s.status === "running" &&
        s.sessionId === undefined &&
        MAP_ITEM_ID_RE.exec(s.label)?.[1] === stepId,
    )
    if (item) {
      item.sessionId = sessionId
      return true
    }
  }
  return false
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
  // (`collectStaticSteps` only keeps string adapters), but the host still
  // registered the spawned session under this step id — without this, such
  // steps reported no sessionId and callers fell back to fuzzy recovery.
  return agents.resolveByLabel(step.label)
}

/** Resolve every step's sessionId by LABEL rather than by (stage, index)
 *  position — a step discovered dynamically at run time (a map/pipeline
 *  item, or any step `runtimeWorkflowToStages` couldn't enumerate ahead of
 *  time) has no positional counterpart in `defs`, only a matching label. */
function fillStepStates(
  stages: WorkflowStageState[],
  defs: WorkflowStage[],
  agents: SessionsRegistryAgentHost,
): string[] {
  const sessionIds: string[] = []
  for (const stage of stages) {
    for (const stepState of stage.steps) {
      const stepDef = findStepDef(defs, stepState.label)
      const resolved = stepDef ? resolveStepSessionId(stepDef, agents) : agents.resolveByLabel(stepState.label)
      // Keep a session `attachStepSession` already recorded at spawn time
      // (F34) — a map item's indexed label never resolves here on its own.
      if (resolved !== undefined) stepState.sessionId = resolved
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

/**
 * F25: `startFromFile`'s `cwd` default. An explicit caller `cwd` always
 * wins. Otherwise, when the workflow is owned by EXACTLY ONE installed app
 * (same ambiguity rule as {@link resolveAppProvenance}), agent steps (and
 * the run itself) default to that app's root — the same root #1395's
 * app-bundled cli drivers spawn under (`packages/app-kit/src/
 * load-app-tools.ts`'s `resolveCliCwd`), so a workflow mixing `tool` and
 * `agent` steps sees one consistent cwd regardless of step kind.
 *
 * No owning app (or the workflow id is ambiguous/unowned) falls back to the
 * daemon's own active workspace (`~/.agentproto/workspaces.json`) — NEVER
 * straight to `process.cwd()` first, since a daemon started under a service
 * manager can have that at `/` (the original F25 bug: an agent step spawned
 * with cwd "/" and ran `find /`). `process.cwd()` is only the very last
 * resort, when no workspace is registered either, and even then a literal
 * "/" is swapped for the user's home directory rather than handed to a
 * spawn.
 */
async function resolveRunCwd(
  appRegistry: Pick<AppRegistry, "getApp" | "listApps"> | undefined,
  workflowId: string,
  explicitCwd: string | undefined,
): Promise<string> {
  if (explicitCwd !== undefined) return explicitCwd
  if (appRegistry !== undefined) {
    const owners = appRegistry.listApps().filter(a => a.workflows.some(w => w.id === workflowId))
    if (owners.length === 1) return owners[0]!.dir
  }
  try {
    const active = getActiveWorkspace(await loadWorkspacesConfig())
    if (active) return active.path
  } catch {
    // Unreadable/corrupt workspaces.json — fall through to the daemon's own
    // cwd rather than failing the run over a config-file read.
  }
  const daemonCwd = process.cwd()
  return daemonCwd === "/" ? homedir() : daemonCwd
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
  eventLog?: RunEventLog,
  lease?: { ownerId: string; heartbeatIntervalMs: number; now: () => Date },
): Promise<void> {
  // AIP-58 §2 owner liveness: renew this run's lease on a timer for as long
  // as THIS process is actually driving it — `sweep()` orphans a run once
  // its lease goes stale, which (for a single in-process runner) only
  // happens once this interval stops firing, i.e. execution ended one way
  // or another. Cleared unconditionally below once execution is done.
  if (lease) {
    const renew = (): void => {
      state.run.lease = { ownerId: lease.ownerId, heartbeatAt: lease.now().toISOString() }
      persist?.()
    }
    renew()
    state.heartbeatTimer = setInterval(renew, lease.heartbeatIntervalMs)
  }

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
  const nonLeafStepIds = collectNonLeafStepIds(runtimeWf.steps)

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

      // AIP-15 rule 7 — durable suspend points: a `kind: "suspend"` step
      // parks the run as "awaiting-input" with a durable `awaitingSuspend`
      // record (persisted like `awaitingApproval`), instead of throwing
      // `WorkflowSuspendedError` and failing the run. An external event
      // resumes through `resumeSuspend` (workflow_escalation_resolve's
      // suspend form); after a daemon restart the run stays suspended and
      // the pending entry is re-registered below.
      resume: (req) =>
        new Promise<unknown>((resolve) => {
          const since = new Date().toISOString()
          state.run.status = "awaiting-input"
          state.run.awaitingSuspend = {
            stepId: req.stepId,
            on: [...req.on],
            since,
          }
          persist?.()
          sessionEvents.emit({
            type: "workflow:suspended",
            runId: state.run.runId,
            stepId: req.stepId,
            on: [...req.on],
            ts: since,
          })
          eventLog?.append({ stepId: req.stepId, type: "step.suspended", data: { on: [...req.on] } })
          eventLog?.append({ type: "run.suspended", data: { stepId: req.stepId } })

          const onAbort = (): void => {
            finish(undefined)
          }
          const finish = (payload: unknown): void => {
            signal.removeEventListener("abort", onAbort)
            state.pendingSuspend = undefined
            if (state.run.awaitingSuspend?.stepId === req.stepId) {
              state.run.awaitingSuspend = undefined
            }
            if (state.run.status === "awaiting-input") state.run.status = "running"
            persist?.()
            const ts = new Date().toISOString()
            sessionEvents.emit({
              type: "workflow:suspend-resumed",
              runId: state.run.runId,
              stepId: req.stepId,
              ts,
            })
            eventLog?.append({ stepId: req.stepId, type: "step.resumed", data: {} })
            eventLog?.append({ type: "run.resumed", data: { stepId: req.stepId } })
            resolve(payload)
          }
          signal.addEventListener("abort", onAbort, { once: true })
          state.pendingSuspend = { stepId: req.stepId, resolve: finish }
        }),

      // AIP-58 §3(a) — an agent-backed step's session called
      // `run.requestInput` (the `run_request_input` MCP tool) before its
      // turn ended. Reuses the exact same durable-suspend mechanics as the
      // `resume` hook above (`state.pendingSuspend`/`awaitingSuspend`,
      // `workflow_escalation_resolve`'s suspend form, daemon-restart
      // re-registration) — only the STEP's own `suspend` record differs:
      // `{ reason: "input-required", prompt, schema? }` instead of `on[]`,
      // taken verbatim from the signal's own payload (never a heuristic
      // read of the turn's text). On resume, `execAgentStep` sends the
      // validated payload back to the SAME session as its next prompt and
      // re-applies the outcome rule — this hook only parks and resolves.
      onInputRequired: (req) =>
        new Promise<unknown>((resolve) => {
          const since = new Date().toISOString()
          const suspend = {
            reason: "input-required" as const,
            prompt: req.prompt,
            ...(req.schema !== undefined ? { schema: req.schema } : {}),
          }
          state.run.status = "awaiting-input"
          state.run.awaitingSuspend = { stepId: req.stepId, since, ...suspend }
          for (const stage of state.run.stages) {
            const step = stage.steps.find((s) => s.label === req.stepId)
            if (step) {
              step.suspend = suspend
              break
            }
          }
          persist?.()
          sessionEvents.emit({
            type: "workflow:suspended",
            runId: state.run.runId,
            stepId: req.stepId,
            ...suspend,
            ts: since,
          })
          eventLog?.append({ stepId: req.stepId, type: "step.suspended", data: suspend })
          eventLog?.append({ type: "run.suspended", data: { stepId: req.stepId, ...suspend } })

          const onAbort = (): void => {
            finish(undefined)
          }
          const finish = (payload: unknown): void => {
            signal.removeEventListener("abort", onAbort)
            state.pendingSuspend = undefined
            if (state.run.awaitingSuspend?.stepId === req.stepId) {
              state.run.awaitingSuspend = undefined
            }
            for (const stage of state.run.stages) {
              const step = stage.steps.find((s) => s.label === req.stepId)
              if (step) {
                step.suspend = undefined
                break
              }
            }
            if (state.run.status === "awaiting-input") state.run.status = "running"
            persist?.()
            const ts = new Date().toISOString()
            sessionEvents.emit({
              type: "workflow:suspend-resumed",
              runId: state.run.runId,
              stepId: req.stepId,
              ts,
            })
            eventLog?.append({ stepId: req.stepId, type: "step.resumed", data: {} })
            eventLog?.append({ type: "run.resumed", data: { stepId: req.stepId } })
            resolve(payload)
          }
          signal.addEventListener("abort", onAbort, { once: true })
          state.pendingSuspend = { stepId: req.stepId, resolve: finish }
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
      onStepStart: (stepId, info) => {
        const cached = info?.cached === true
        if (nonLeafStepIds.has(stepId)) return
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
        // Find and mark the step as running — or, for a step
        // `collectStaticSteps` couldn't enumerate ahead of time (a
        // map/pipeline fan-out item, id `base[idx]`), append it as a newly
        // DISCOVERED real step (AIP-58 §5 / F28: `workflow_status` shows
        // every step that actually ran, not just the statically-known ones).
        let found = false
        for (const stage of state.run.stages) {
          const step = stage.steps.find((s) => s.label === stepId)
          if (step) {
            found = true
            if (step.status === "pending") {
              step.status = "running"
              step.startedAt = new Date().toISOString()
              moveToExecutionOrder(stage, step)
            }
            if (cached) step.cached = true
            // Update stage status if it's still pending
            if (stage.status === "pending") {
              stage.status = "running"
            }
            break
          }
        }
        if (!found) {
          const stage = state.run.stages[state.run.stages.length - 1]
          if (stage) {
            const step: RoutineStepState = {
              index: stage.steps.reduce((max, s) => Math.max(max, s.index + 1), 0),
              label: stepId,
              status: "running",
              startedAt: new Date().toISOString(),
              ...(cached ? { cached: true } : {}),
            }
            stage.steps.push(step)
            moveToExecutionOrder(stage, step)
            if (stage.status === "pending") stage.status = "running"
          }
        }
        persist?.()
        eventLog?.append({ stepId, type: "step.started", data: cached ? { cached: true } : {} })
      },
      onStepComplete: (stepId, output, info) => {
        const cached = info?.cached === true
        if (nonLeafStepIds.has(stepId)) return
        runningSteps.delete(stepId)
        // Find and mark the step as done
        let doneStep: (typeof state.run.stages)[number]["steps"][number] | undefined
        for (const stage of state.run.stages) {
          const step = stage.steps.find((s) => s.label === stepId)
          if (step) {
            doneStep = step
            step.status = "done"
            step.endedAt = new Date().toISOString()
            step.output = output
            if (cached) step.cached = true
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
        // `run.stages` — gate steps have no tracked row (collectStaticSteps
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
        eventLog?.append({ stepId, type: "step.succeeded", data: cached ? { cached: true } : {} })
      },
    })

    // Success — close out every stage/step. A step that started but whose
    // completion was never observed is done (fallback for any missed hook);
    // one that never started at all (an untaken branch arm, F31) is
    // `skipped`, never a fabricated `done`.
    for (const stage of state.run.stages) {
      if (stage.status !== "done") stage.status = "done"
      for (const step of stage.steps) {
        if (step.status === "pending") {
          step.status = "skipped"
        } else if (step.status !== "done") {
          step.status = "done"
          step.endedAt = new Date().toISOString()
        }
      }
    }
    state.run.status = "done"
    state.run.endedAt = new Date().toISOString()

    const sessionIds = fillStepStates(state.run.stages, state.stages, agents)
    if (sessionIds.length > 0) state.run.result = { sessionIds }
    eventLog?.append({ type: "run.succeeded", data: {} })
  } catch (err) {
    const blockedReason = signal.aborted ? "run aborted" : err instanceof Error ? err.message : String(err)
    for (const stepId of runningSteps) {
      ledgerAppend?.({
        stage: stepId,
        kind: "blocked",
        payload: { reason: blockedReason, runId: state.run.runId },
      })
    }
    if (signal.aborted) {
      // `run.cancelled` is emitted by `cancel()` itself (the only caller
      // that ever aborts `signal`) — not here, to avoid a duplicate event.
      runningSteps.clear()
      state.run.status = "cancelled"
      state.run.endedAt = new Date().toISOString()
    } else {
      const errMsg = err instanceof Error ? err.message : String(err)
      state.run.status = "failed"
      state.run.error = errMsg
      state.run.endedAt = new Date().toISOString()
      // AIP-58 §10: a structured outcome-rule failure carries its own error
      // code onto the run record, and — when the heuristic matched — a
      // `hint` onto the specific step that failed (never onto every step in
      // the stage; the hint is per-step evidence, not a run-wide fact).
      let errorCode: string | undefined
      if (err instanceof StepOutcomeError) {
        errorCode = err.code
        state.run.errorCode = err.code
        if (err.hint) {
          for (const stage of state.run.stages) {
            const step = stage.steps.find((s) => s.label === err.stepId)
            if (step) {
              step.hint = err.hint
              break
            }
          }
        }
      }

      // A structured outcome failure (StepOutcomeError) names exactly which
      // step failed; any other error fails every step that was still
      // running when it landed (`runningSteps`, captured above).
      const failedStepIds = err instanceof StepOutcomeError ? [err.stepId] : [...runningSteps]

      // F29: project the failure onto the steps it actually hit — the SAME
      // steps the event log records `step.failed` for below. A step that
      // already succeeded stays `done`; one that never started stays
      // `pending` (a later stage never reached is untouched). Only a failed
      // step carries the error; an in-flight sibling of a structured
      // outcome failure is failed WITHOUT a copy of someone else's error.
      const failedSet = new Set(failedStepIds)
      const endedAt = new Date().toISOString()
      for (const stage of state.run.stages) {
        let stageFailed = false
        for (const step of stage.steps) {
          const itemBase = MAP_ITEM_ID_RE.exec(step.label)?.[1]
          const hit =
            failedSet.has(step.label) ||
            (step.status === "running" && itemBase !== undefined && failedSet.has(itemBase))
          if (hit) {
            step.status = "failed"
            step.endedAt = endedAt
            step.error = errMsg
            stageFailed = true
          } else if (step.status === "running") {
            step.status = "failed"
            step.endedAt = endedAt
            stageFailed = true
          }
        }
        if (stageFailed || stage.status === "running") stage.status = "failed"
      }

      // Resolve step sessionIds on FAILURE too — previously only the success
      // path did this, so a run whose agent session spawned and then errored
      // reported failed steps with NO sessionId, leaving callers (e.g. the CI
      // driver) blind: no handle to `agent_output` the dead session's last
      // words. The host's label map is populated at spawn time, so any
      // session that got as far as spawning resolves here.
      const sessionIds = fillStepStates(state.run.stages, state.stages, agents)
      if (sessionIds.length > 0) state.run.result = { sessionIds }

      for (const stepId of failedStepIds) {
        eventLog?.append({
          stepId,
          type: "step.failed",
          data: { message: errMsg, ...(errorCode !== undefined ? { code: errorCode } : {}) },
        })
      }
      runningSteps.clear()
      eventLog?.append({
        type: "run.failed",
        data: { message: errMsg, ...(errorCode !== undefined ? { code: errorCode } : {}) },
      })
    }
  }

  // Execution is over one way or another — the lease is no longer this
  // process's to renew (a terminal run has no owner; §2 only requires one
  // for `running`).
  if (state.heartbeatTimer) {
    clearInterval(state.heartbeatTimer)
    state.heartbeatTimer = undefined
  }
  state.run.lease = undefined

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
  /** Root directory for AIP-58 §5 per-run event logs
   *  (`<runsRoot>/<runId>/events.jsonl`). Defaults to `~/.agentproto/runs`.
   *  Only written when persistence (above) is on — mirrors `persistPath`'s
   *  own opt-in-for-tests posture. */
  runsRoot?: string
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
  /** Stable id for THIS process/instance, stamped onto every lease this
   *  runner takes out (`WorkflowRun.lease.ownerId`). Defaults to a fresh
   *  `randomUUID()` per runner — override only to simulate a specific owner
   *  in a test. */
  ownerId?: string
  /** AIP-58 §2 lease TTL — a `running` run's lease older than this with no
   *  renewal is `orphaned` by `sweep()`. Defaults to 60s: long enough that a
   *  couple of missed heartbeats (see `heartbeatIntervalMs`) don't
   *  false-positive on ordinary scheduling jitter, short enough that a
   *  genuinely dead owner doesn't stay "running" for hours (open question in
   *  the spec itself — this is the reference implementation's deliberate
   *  choice, not a normative value). */
  leaseTtlMs?: number
  /** How often an in-flight run's lease is renewed. Defaults to 15s — a
   *  quarter of the default TTL, so a run survives one or two missed
   *  renewals before `sweep()` would call it orphaned. */
  heartbeatIntervalMs?: number
  /** Clock override for lease timestamps AND `sweep()`'s "now" — tests only;
   *  defaults to `() => new Date()`. */
  now?: () => Date
}): WorkflowRunner {
  const { registry, sessionEvents, resolveAgentAdapter, compileWorkflow } = opts
  const persistPath = opts.persistPath ?? DEFAULT_PERSIST_PATH()
  const shouldPersist = opts.persist ?? (opts.persistPath !== undefined)
  const runsRoot = opts.runsRoot ?? DEFAULT_RUNS_ROOT()
  const ownerId = opts.ownerId ?? randomUUID()
  const leaseTtlMs = opts.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS
  const heartbeatIntervalMs = opts.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS
  const now = opts.now ?? (() => new Date())

  const runs = shouldPersist ? loadRuns(persistPath, runsRoot) : new Map<string, RunState>()

  const persist = (): void => {
    if (shouldPersist) saveRuns(runs, persistPath)
  }

  const newEventLog = (runId: string): RunEventLog | undefined =>
    shouldPersist ? createRunEventLog(runId, runsRoot) : undefined

  // Gated on persistence like the event log above — without it there's no
  // other process that could ever observe a lease, and skipping the
  // heartbeat timer entirely keeps a non-persisting caller (most unit
  // tests) free of a recurring interval it never asked for.
  const leaseOpts = shouldPersist ? { ownerId, heartbeatIntervalMs, now } : undefined

  // AIP-58 §9 `run.requestInput` (the `run_request_input` MCP tool): a
  // sessionId → (runId, stepId, host) index spanning every run this runner
  // has ever dispatched an agent step for, populated by each run's
  // `SessionsRegistryAgentHost`'s `onSessionLabeled` callback and pruned
  // once that run reaches a terminal state (see the `.then()` after each
  // `executeRunWorkflow` call below).
  const sessionToRun = new Map<string, { runId: string; stepId: string; host: SessionsRegistryAgentHost }>()

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

  // ── Reload re-registration (AIP-15 rule 7, suspend points) ───────────
  //
  // A run parked at a `kind: "suspend"` step survives the restart with its
  // durable `awaitingSuspend` record intact (loadRuns keeps it suspended).
  // The live resume hook died with the old process, so re-register the
  // pending entry here: a matching resume still resolves (event emitted
  // exactly once), but the run's execution can't resume and it is marked
  // failed with a clear reason — never a silent loss, never a pre-restart
  // failure.
  const reRegisterReloadedSuspends = (): void => {
    for (const state of runs.values()) {
      const run = state.run
      const as = run.awaitingSuspend
      if (run.status !== "awaiting-input" || !as) continue
      const resolveAfterRestart = (_payload: unknown): void => {
        if (state.pendingSuspend?.stepId !== as.stepId) return
        state.pendingSuspend = undefined
        run.awaitingSuspend = undefined
        run.status = "failed"
        run.error =
          "suspend resolved after daemon restart — the run's execution could not resume"
        run.endedAt = run.endedAt ?? new Date().toISOString()
        persist()
        sessionEvents.emit({
          type: "workflow:suspend-resumed",
          runId: run.runId,
          stepId: as.stepId,
          ts: new Date().toISOString(),
        })
      }
      state.pendingSuspend = { stepId: as.stepId, resolve: resolveAfterRestart }
    }
  }
  reRegisterReloadedSuspends()

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
      const eventLog = newEventLog(runId)
      const state: RunState = {
        run,
        cancelled: false,
        abort,
        stages: input.stages,
        ...(eventLog !== undefined ? { eventLog } : {}),
        ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
        ...(input.workspaceSlug !== undefined ? { workspaceSlug: input.workspaceSlug } : {}),
      }
      runs.set(runId, state)
      persist()
      eventLog?.append({ type: "run.created", data: { workflowId: input.workflowId } })
      eventLog?.append({ type: "run.started", data: {} })

      // Translate stages → RuntimeWorkflow and launch.
      const workflow = translateStages(input.stages, input.workflowId)
      const agents: SessionsRegistryAgentHost = new SessionsRegistryAgentHost(
        registry,
        sessionEvents,
        resolveAgentAdapter,
        {
          workspaceSlug: input.workspaceSlug,
          cwd: input.cwd,
          notifyUrl: input.notifyUrl,
          onEscalate: createOnEscalate(state, persist),
          onSessionLabeled: (stepId, sessionId) => {
            sessionToRun.set(sessionId, { runId, stepId, host: agents })
            if (attachStepSession(state.run, stepId, sessionId)) persist()
          },
          ...(opts.resolveSandboxProvider
            ? { resolveSandboxProvider: opts.resolveSandboxProvider }
            : {}),
        },
      )

      const cache = input.cacheKey ? createFileStepCache(input.cacheKey) : undefined

      void executeRunWorkflow(state, workflow, agents, abort.signal, sessionEvents, cache, input.cacheKey, undefined, persist, opts.appRegistry, eventLog, leaseOpts).then(() => {
        for (const [sid, binding] of sessionToRun) {
          if (binding.runId === runId) sessionToRun.delete(sid)
        }
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

      // AIP-58 §3 Outcome rule: invalid/missing required input is rejected
      // BEFORE any step runs — never a `compileWorkflow` call, never an
      // `executeRunWorkflow` dispatch, so zero steps execute and zero
      // sessions spawn on a rejected run.
      const validation = validateWorkflowInput(handle.inputs, args.input)
      if (!validation.valid) {
        const runId = `wfrun_${randomUUID()}`
        const now = new Date().toISOString()
        const run: WorkflowRun = {
          runId,
          workflowId: handle.id,
          status: "failed",
          startedAt: now,
          endedAt: now,
          stages: [],
          error: validation.message,
          errorCode: validation.code,
          ...resolveAppProvenance(opts.appRegistry, handle.id, {
            ...(args.appId !== undefined ? { appId: args.appId } : {}),
            ...(args.appRunId !== undefined ? { appRunId: args.appRunId } : {}),
            ...(args.item !== undefined ? { item: args.item } : {}),
          }),
        }
        const eventLog = newEventLog(runId)
        runs.set(runId, { run, cancelled: false, abort: new AbortController(), stages: [], ...(eventLog !== undefined ? { eventLog } : {}) })
        persist()
        // AIP-58 §3/V1: rejected before dispatch — `run.created` then
        // `run.failed` ONLY. `run.started` MUST NOT appear; the run never
        // entered the running state.
        eventLog?.append({ type: "run.created", data: { workflowId: handle.id } })
        eventLog?.append({ type: "run.failed", data: { code: validation.code, message: validation.message } })
        return run
      }

      const workflow = await compileWorkflow(handle)
      // Visible rows leave out untaken-until-proven branch-arm steps (F31);
      // the defs keep them for sessionId resolution.
      const fileStages = runtimeWorkflowToStages(workflow)
      const fileStepDefs = runtimeWorkflowToStages(workflow, { includeConditional: true })
      const runId = `wfrun_${randomUUID()}`
      // F25: resolved BEFORE the run record so `cwd` is recorded even when
      // defaulted (never a silent "/" — see resolveRunCwd).
      const cwd = await resolveRunCwd(opts.appRegistry, handle.id, args.cwd)
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
        cwd,
        ...resolveAppProvenance(opts.appRegistry, handle.id, {
          ...(args.appId !== undefined ? { appId: args.appId } : {}),
          ...(args.appRunId !== undefined ? { appRunId: args.appRunId } : {}),
          ...(args.item !== undefined ? { item: args.item } : {}),
        }),
      }
      const abort = new AbortController()
      const eventLog = newEventLog(runId)
      const state: RunState = {
        run,
        cancelled: false,
        abort,
        stages: fileStepDefs,
        ...(eventLog !== undefined ? { eventLog } : {}),
        // ...(args.cwd !== undefined ? { cwd: args.cwd } : {}),
        cwd,
        ...(args.workspaceSlug !== undefined ? { workspaceSlug: args.workspaceSlug } : {}),
      }
      runs.set(runId, state)
      persist()
      eventLog?.append({ type: "run.created", data: { workflowId: handle.id } })
      eventLog?.append({ type: "run.started", data: {} })

      const agents: SessionsRegistryAgentHost = new SessionsRegistryAgentHost(
        registry,
        sessionEvents,
        resolveAgentAdapter,
        {
          workspaceSlug: args.workspaceSlug,
          cwd,
          onEscalate: createOnEscalate(state, persist),
          onSessionLabeled: (stepId, sessionId) => {
            sessionToRun.set(sessionId, { runId, stepId, host: agents })
            if (attachStepSession(state.run, stepId, sessionId)) persist()
          },
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
        eventLog,
        leaseOpts,
      ).then(() => {
        for (const [sid, binding] of sessionToRun) {
          if (binding.runId === runId) sessionToRun.delete(sid)
        }
        persist()
      })

      return run
    },

    status: (runId) => runs.get(runId)?.run,

    list: () => Array.from(runs.values()).map(s => s.run),

    events: (runId, sinceSeq) => (runs.has(runId) ? readRunEvents(runId, runsRoot, sinceSeq) : undefined),

    // AIP-58 §2 owner liveness — see the interface doc comment. A run this
    // SAME process is actively driving always has a fresh lease (the
    // heartbeat interval in `executeRunWorkflow` keeps renewing it), so
    // staleness alone is sufficient to identify one whose owner is gone —
    // no separate ownerId comparison needed for a single-process runner.
    sweep: (sweepNow) => {
      const nowMs = (sweepNow ?? now()).getTime()
      const orphaned: string[] = []
      for (const state of runs.values()) {
        const run = state.run
        if (run.status !== "running" || !run.lease) continue
        const staleMs = nowMs - Date.parse(run.lease.heartbeatAt)
        if (!(staleMs > leaseTtlMs)) continue
        // Not `state.abort.abort()`: an in-flight `executeRunWorkflow` for
        // THIS run would race this write with its own catch block's
        // `status = "cancelled"`, clobbering the "orphaned" verdict moments
        // later. Marking the record and killing the renewal timer is
        // sufficient — a genuinely orphaned owner (the premise this exists
        // for) isn't running in THIS process to race with anyway.
        if (state.heartbeatTimer) {
          clearInterval(state.heartbeatTimer)
          state.heartbeatTimer = undefined
        }
        run.status = "failed"
        run.error = `run orphaned — owner "${run.lease.ownerId}"'s lease expired ${staleMs}ms ago (ttl ${leaseTtlMs}ms)`
        run.errorCode = "orphaned"
        run.endedAt = new Date(nowMs).toISOString()
        run.lease = undefined
        persist()
        state.eventLog?.append({ type: "run.failed", data: { code: "orphaned", message: run.error } })
        orphaned.push(run.runId)
      }
      return { orphaned }
    },

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

    // Resolve a parked `kind: "suspend"` step (AIP-15 rule 7). Works both
    // for a live run (the resume hook's resolver) and for a run
    // re-registered after a daemon restart.
    resumeSuspend: (runId, input) => {
      const state = runs.get(runId)
      if (!state) {
        return {
          ok: false,
          error: "run_not_found",
          message: `no workflow run "${runId}"`,
        }
      }
      const ps = state.pendingSuspend
      if (!ps) {
        return {
          ok: false,
          error: "not_awaiting_suspend",
          message: `run "${runId}" is not awaiting a suspend event (status: ${state.run.status})`,
        }
      }
      if (input.stepId !== undefined && input.stepId !== ps.stepId) {
        return {
          ok: false,
          error: "step_id_mismatch",
          message: `run "${runId}" is suspended at step "${ps.stepId}", not "${input.stepId}"`,
        }
      }
      // AIP-58 §3/§9: when the parked record carries a `schema` (the
      // `run.requestInput` case — a plain `kind: "suspend"` step's
      // `awaitingSuspend` never has one), the resume payload MUST validate
      // against it BEFORE the transition happens. An invalid payload is
      // rejected and the run stays suspended — `ps.resolve` is never called.
      const schema = state.run.awaitingSuspend?.schema
      if (schema !== undefined) {
        const validation = validateAgainstJsonSchema(schema, input.payload)
        if (!validation.valid) {
          return { ok: false, error: "invalid_payload", message: `resume payload ${validation.message}` }
        }
      }
      ps.resolve(input.payload)
      return { ok: true }
    },

    // AIP-58 §9 `run.requestInput`: resolve `sessionId` (the calling
    // session) → the run/step that spawned it, via the sessionToRun index
    // every `SessionsRegistryAgentHost` maintains through `onSessionLabeled`.
    recordInputRequest: (sessionId, req) => {
      const binding = sessionToRun.get(sessionId)
      if (!binding) {
        return { ok: false, error: "session_not_in_workflow_step" }
      }
      binding.host.recordInputRequest(sessionId, req)
      return { ok: true, runId: binding.runId, stepId: binding.stepId }
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
        state.eventLog?.append({ type: "run.cancelled", data: {} })
      }
    },
  }
}