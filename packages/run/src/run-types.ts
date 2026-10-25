/**
 * Pure run-record types for the AIP-58 run substrate.
 *
 * `WorkflowRun` and the stage/step shapes it is built from live here so
 * `@agentproto/run` can persist and read a run without importing the daemon
 * runner. `@agentproto/runtime`'s `workflow-runner.ts` imports and re-exports
 * them, so every existing import keeps working.
 */

import type { AgentSandboxRef, ArtifactEntry } from "@agentproto/workflow-runtime"

import type { RoutinePolicy, RoutineStepState } from "./step-run-types.js"

export interface WorkflowStep {
  label: string
  /** Prompt to send to the agent. Omit to just spawn/reuse and wait. */
  prompt?: string
  /** Adapter slug for spawning a NEW session. Omit to reuse a prior session. */
  adapter?: string
  /** Model id override forwarded to the spawn - same semantics as
   *  `agent_start.model`. Omitted ⇒ unchanged behaviour (the adapter keeps
   *  its default). Only meaningful with `adapter`. */
  model?: string
  /** Reuse the session spawned by an earlier step (any prior stage),
   *  identified by that step's `label`. Ignored if `adapter` is set. */
  sessionRef?: string
  /** Run this step's session inside a sandbox - a provider slug (e.g.
   *  `"local"`, `"e2b"`) or an inline AIP-36 spec object. Only meaningful
   *  with `adapter`. Requires the runner to be wired with
   *  `resolveSandboxProvider`; fails loudly otherwise. */
  sandbox?: AgentSandboxRef
  policy?: RoutinePolicy
  /** Cache this step's output under the run's `cacheKey` - opt-in, for idempotent steps. */
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
  status: "pending" | "running" | "done" | "failed" | "skipped" | "cancelled"
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
  /** AIP-58 §10 error code for `error`, when the failure has one - today
   *  only `startFromFile`'s pre-dispatch input-validation rejection sets
   *  this (`"invalid-input"`). Absent on every other failure path. */
  errorCode?: string
  result?: { sessionIds: string[] }
  /** The workflow's own final output (its declared `result` block, else the
   *  last step's output) - set when the run completes `done`. Persisted with
   *  the run and returned by `workflow_status` (compact form included), so a
   *  run's report outlives the run without the caller digging it out of one
   *  step's `output`. */
  output?: unknown
  /** F25: the working directory agent steps (and the run itself) spawn
   *  under - the caller's explicit `cwd` when given, else `startFromFile`'s
   *  resolved default (owning app's root > daemon's active workspace >
   *  process cwd, never a bare "/"; see `resolveRunCwd`). Recorded here even
   *  when defaulted, so a run's actual spawn location is never silently
   *  invisible. Only set by `startFromFile` today - `start` (the
   *  `WorkflowStage[]` path) is unaffected by this default. */
  cwd?: string
  /** App provenance - set when the run was started on behalf of an
   *  installed app (explicit input, or the workflow id is owned by exactly
   *  one installed app per the registry). Drives the app state ledger
   *  appends in `executeRunWorkflow` (see `createLedgerAppender`). */
  appId?: string
  /** The app_run this run belongs to, when started through an app. */
  appRunId?: string
  /** The session that started this run (`workflow_start` / `workflow_run_file`
   *  over an MCP connection carrying `callerSessionId`). The runner posts ONE
   *  AIP-46 inbox item to it when the run succeeds, fails, or parks for an
   *  approval / input - so a caller that is not a daemon-spawned agent (an
   *  `external` Desktop session) still hears about its run. Inherited by
   *  `retry()`. */
  callerSessionId?: string
  /** AIP-58 §4 Run workspace - `<runsRoot>/<runId>/`, this run's own
   *  allocation (never shared with another run). Steps see the `scratch/`
   *  subdirectory as `$run.workspace` / `{{run.workspace}}`; every
   *  `artifacts[]` entry's `path` is relative to THIS root. Set at run
   *  creation (`ensureRunWorkspace`), so it's populated even before
   *  execution starts. */
  workspace?: string
  /** AIP-58 §1/§4 `Run.artifacts[]` - every file a `kind: "artifact"` step
   *  (or a declared `outputsFiles` key) has copied into
   *  `<workspace>/artifacts/` so far. Compact `workflow_status` projects
   *  this to `{key, path, size}` (see `compactWorkflowRunStatus`). */
  artifacts?: ArtifactEntry[]
  /** AIP-16 `outputsFiles` (as amended by AIP-58 §4), copied from the
   *  compiled workflow at `startFromFile` time - retained so `publish()`
   *  can resolve an artifact key's default destination (`to`) without
   *  re-loading/re-compiling the WORKFLOW.md. Only set by `startFromFile`. */
  outputsFiles?: Record<string, { path: string; required?: boolean; contentType?: string }>
  /** Optional ledger `item` - stamped on EVERY app-ledger event this run
   *  appends, scoping them to one sub-key inside each stage (e.g. the map
   *  item or entity the run processes). */
  item?: string
  /** Set while the run is parked at a `kind: "approval"` step (status
   *  "awaiting-approval") - the human-in-the-loop inbox entry. Cleared on
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
   *  `StepRecord.suspend` exactly - status "awaiting-input" either way).
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
  /** AIP-58 §2 "a `running` run MUST have a live owner" - a lease with a
   *  heartbeat. Set at dispatch, renewed on a timer while `executeRunWorkflow`
   *  is in flight, persisted with every renewal. `sweep()` marks the run
   *  `failed { code: "orphaned" }` once `heartbeatAt` is older than the
   *  runner's `leaseTtlMs` - the case a host restart doesn't catch (the
   *  owning process/worker died without the DAEMON itself restarting). Only
   *  meaningful while `status === "running"`; cleared on every terminal
   *  transition and on reload (a fresh process is a fresh owner). */
  lease?: {
    ownerId: string
    heartbeatAt: string
  }
  /** AIP-58 §6 Journal - set on a run created by `retry()`: the runId it
   *  retried. Absent on an original (non-retried) run. There is no
   *  `retryOf`/`replayOf` field on the spec's own Run resource (V7's own
   *  vector note: the linkage lives on `run.created`'s event `data` only) -
   *  this host records it on the run record too, so `workflow_status` and
   *  `workflow_list` show the lineage without a caller having to page the
   *  event log. Mirrored onto `run.created`'s `data.retryOf` either way. */
  retryOf?: string
  /** The workflow's own `$input` binding, when this run has one
   *  (`startFromFile`-originated runs only - `start()`'s `WorkflowStage[]`
   *  path has no `$input` binding, see `translateStages`). Persisted (not
   *  just held in the in-memory `RunState`) so `retry()` can rebuild the
   *  SAME binding - or apply a caller override - after a daemon restart,
   *  when nothing but this record survives. */
  input?: unknown
  /** `startFromFile`'s own `path` - persisted so `retry()` can reload +
   *  recompile the SAME WORKFLOW.md after a daemon restart. Absent on a
   *  `start()`-originated run (see `startStages` below instead). */
  path?: string
  /** `start()`'s own `stages` - persisted so `retry()` can rebuild the SAME
   *  `RuntimeWorkflow` (via `translateStages`) after a daemon restart.
   *  Absent on a `startFromFile`-originated run (see `path` above instead). */
  startStages?: WorkflowStage[]
  /** `workspaceSlug` passed to `start()`/`startFromFile()` - persisted
   *  (unlike the in-memory-only `RunState.workspaceSlug`) so `retry()` can
   *  reuse it after a daemon restart. */
  workspaceSlug?: string
}

