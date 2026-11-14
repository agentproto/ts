/**
 * @agentproto/run: the AIP-58 run substrate.
 *
 * The host-owned pieces a run needs but the daemon runner does not own:
 * the per-run workspace layout, the append-only event log, the on-disk run
 * store, the file-backed step cache, and the pure run-record types those
 * modules persist. `@agentproto/runtime` depends on this package and
 * re-exports the same public names.
 *
 * @see https://agentproto.sh/docs/aip-58
 */

export const SPEC_NAME = "run/v1" as const

export { ensureRunWorkspace, runWorkspacePaths } from "./run-workspace.js"
export type { RunWorkspacePaths } from "./run-workspace.js"

export { DEFAULT_RUNS_ROOT, createRunEventLog, readRunEvents } from "./run-event-log.js"
export type { RunEventEnvelope, RunEventLog } from "./run-event-log.js"

export { createFileStepCache } from "./workflow-step-cache.js"

export type { RoutinePolicy, RoutineStepState } from "./step-run-types.js"

export type {
  WorkflowRun,
  WorkflowRunStatus,
  WorkflowStage,
  WorkflowStageState,
  WorkflowStep,
} from "./run-types.js"

export {
  DEFAULT_OUTPUT_LIMITS,
  RUN_OUTPUT_REF,
  STEP_OUTPUT_REF_PREFIX,
  applyOutputCeilings,
  boundOutput,
  clipError,
  isBoundedOutputRef,
  leaseFilePath,
  listLeaseRunIds,
  listRunIds,
  migrateLegacyRuns,
  readRunFull,
  readRunHeader,
  readSpillValue,
  removeLeaseFile,
  removeLeaseFileSync,
  runFilePath,
  runStoreDir,
  serializeRunFile,
  slimRun,
  spillFilePath,
  spillRelativePath,
  stepOutputRef,
  writeFileAtomic,
  writeFileAtomicSync,
  writeLeaseFile,
  writeSpill,
  writeSpillSync,
} from "./workflow-run-store.js"
export type {
  BoundedOutputRef,
  LegacyMigrationResult,
  WorkflowOutputLimits,
} from "./workflow-run-store.js"
