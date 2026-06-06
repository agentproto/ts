/**
 * @agentproto/corpus — composition of AIP-10/12/18/9/15/41.
 *
 * Spec: https://agentproto.sh/docs/corpus
 */

export const SPEC_NAME = "agentcorpus/v1" as const
export const SPEC_VERSION = "0.1.0-alpha" as const

// Shared slug + language utilities (single source of truth)
export {
  slugify,
  uniqueSlug,
  isSourceSlug,
  isEntrySlug,
  type SlugifyOptions,
} from "./util/slug.js"
export { normalizeLanguageTag } from "./util/language.js"

// Types
export type {
  FileKind,
  ParsedFile,
  CorpusWorkspaceSnapshot,
  ValidationIssue,
  ValidationResult,
  LintIssue,
  LintReport,
  CorpusEventKind,
  CorpusEvent,
  CorpusPreset,
  CorpusPresetBootstrapContext,
  Attestation,
  AttestationKind,
} from "./types.js"

// Access — attestations + access policy + capability levels
export {
  appendAttestation,
  readAttestations,
  makeAttestation,
} from "./lifecycle/attestations.js"
export {
  evaluateAccess,
  readAccessSpec,
} from "./access/policy.js"
export type {
  AccessClassification,
  AccessCaller,
  AccessContext,
  AccessDecision,
  CorpusAccessSpec,
} from "./access/policy.js"
export {
  evaluateCapability,
  readAccessModes,
} from "./access/capability.js"
export type {
  AccessModesMap,
  Capability,
  CapabilityCaller,
  CapabilityDecision,
  CapabilityRule,
} from "./access/capability.js"

// i18n / language filter
export {
  resolveLanguageFilter,
  matchesLanguageFilter,
  readOperatorLocale,
  readWorkspaceDefaultLanguage,
  readEntryLanguage,
} from "./access/language.js"
export type {
  LanguageFilter,
  ResolveLanguageFilterInput,
} from "./access/language.js"

// Importers
export { ImporterRunner } from "./importers/runner.js"
export { LocalFilesImporter } from "./importers/local-files.js"
export { KbMigrationImporter } from "./importers/kb-migration.js"
export { WebImporter } from "./importers/web.js"
export type {
  CorpusImporter,
  ImporterTarget,
  ImportedSource,
  BatchReport,
  ImporterRunnerOptions,
} from "./importers/types.js"
export type { LocalFilesImporterOptions } from "./importers/local-files.js"
export type { WebImporterOptions } from "./importers/web.js"

// Distill — raw source → refined entries (KNOWLEDGE layer)
export { DistillRunner } from "./distill/runner.js"
export type {
  DistillRunnerOptions,
  DistillSource,
  DistillRunReport,
} from "./distill/runner.js"
export type {
  DistillPort,
  DistillInput,
  DistilledItem,
  RefinedKind,
} from "./distill/types.js"
export { REFINED_KIND_SCHEMA, isRefinedKind } from "./distill/types.js"

// Knowledge resolver — the `knowledge:` binding (KNOWLEDGE → SKILL link)
export { resolveKnowledge } from "./knowledge/resolve.js"
export type {
  KnowledgeQuery,
  ResolvedEntry,
  SourceRef,
  ResolveKnowledgeOptions,
} from "./knowledge/resolve.js"

// Overlay — guild edits shadow read-only packs (the customization engine)
export { OverlayFs, ReadOnlyFs } from "./knowledge/overlay-fs.js"

// In-memory FsPort — backs build-time-inlined knowledge packs (no runtime fs)
export { MemFs } from "./knowledge/mem-fs.js"

// Sink — agnostic outbound (corpus → external store via a config/MCP sink)
export { SyncRunner } from "./sink/runner.js"
export type { SyncRunnerOptions, SyncReport } from "./sink/runner.js"
export type { SinkPort, SinkItem, SinkPushResult } from "./sink/types.js"
export type {
  KbMigrationConfig,
  KbListLike,
  KbSourceLike,
} from "./importers/kb-migration.js"

// Calibration — reviewer track record + multi-reviewer aggregator
export { aggregateReviewerScores } from "./calibration/aggregate.js"
export type {
  AggregateOptions,
  AggregateResult,
  ReviewerScore,
} from "./calibration/aggregate.js"
export { ReviewerTrackRecord } from "./calibration/track-record.js"
export type {
  ReviewerTrackRecordOptions,
  TrackRecordEntry,
} from "./calibration/track-record.js"
export {
  pearsonCorrelation,
  computeReviewerCalibration,
} from "./calibration/correlation.js"
export type {
  CalibrationOptions,
  ReviewerCalibration,
} from "./calibration/correlation.js"

// Re-export the most commonly consumed ports from the main barrel so
// the agstudio side (corpus engine adapter) doesn't need the subpath.
// Full port surface lives under `@agentproto/corpus/ports`.
export type {
  FsPort,
  FsStat,
  FsLockHandle,
} from "./ports/fs.port.js"
export type { ClockPort } from "./ports/clock.port.js"
export type { IdentityPort, CallerIdentity } from "./ports/identity.port.js"
export type {
  FetcherPort,
  FetchedSource,
  FetchedSourceKind,
} from "./ports/fetcher.port.js"
export { systemClock } from "./ports/clock.port.js"

// Workspace
export { CorpusWorkspaceReader } from "./workspace/reader.js"
export {
  CorpusWorkspaceWriter,
  CorpusVersionConflictError,
} from "./workspace/writer.js"
export type {
  CorpusWorkspaceReaderOptions,
} from "./workspace/reader.js"
export type {
  CorpusWorkspaceWriterOptions,
  MarkdownDoc,
} from "./workspace/writer.js"

// Validate
export { CorpusValidator } from "./validate/validator.js"
export type {
  CorpusValidatorOptions,
  AipSchemaKey,
  AipSchemaBundle,
} from "./validate/validator.js"
export { CorpusLinter } from "./validate/linter.js"
export type {
  CorpusLinterOptions,
  CustomLintRunner,
} from "./validate/linter.js"

// Events
export { CorpusEventEmitter } from "./events/emitter.js"
export type {
  CorpusEventEmitterOptions,
} from "./events/emitter.js"

// Sidecar
export {
  CandidatesSidecar,
  SidecarDuplicateError,
  SidecarNotFoundError,
} from "./workspace/sidecar.js"
export type {
  CandidateRow,
  CandidatesSidecarOptions,
} from "./workspace/sidecar.js"

// Lifecycle
export {
  DEFAULT_TRANSITIONS,
  canTransition,
  assertTransition,
  transitionGraphFromCollection,
  IllegalTransitionError,
} from "./lifecycle/candidate.js"
export type {
  CandidateStatus,
  TransitionCheck,
} from "./lifecycle/candidate.js"
export {
  evaluateGate,
  extractAutoPromoteConfig,
} from "./lifecycle/gate.js"
export type {
  AutoPromoteConfig,
  AutoPromoteRequirements,
  CandidateForGate,
  GateFailure,
  GateResult,
} from "./lifecycle/gate.js"
export { CorpusPromoter, PromoteRejectedError } from "./lifecycle/promote.js"
export type {
  PromoteOptions,
  PromoteResult,
  PromoteContext,
} from "./lifecycle/promote.js"

// Index
export { CorpusIndexer } from "./index/indexer.js"
export type {
  CorpusIndexerOptions,
  IndexReport,
} from "./index/indexer.js"
export { chunkText } from "./index/chunker.js"
export type { ChunkerOptions } from "./index/chunker.js"

// Writer port — the kit's seam into a backing engine
export type {
  WriterPort,
  WriterChunk,
  PushChunksInput,
} from "./ports/writer.port.js"

// Evaluator port — the kit's seam into a backing evaluator engine.
// @agstudio/integration-evaluator's IEvaluator satisfies it structurally.
export type {
  EvaluatorPort,
  EvalInputPort,
  EvalResultPort,
  EvalRubricPort,
  EvalContextPort,
} from "./ports/evaluator.port.js"

// Playbooks (AIP-12)
export { PlaybookRegistry } from "./playbooks/registry.js"
export type { PlaybookRegistryOptions } from "./playbooks/registry.js"
export {
  OperatorOverlayResolver,
  renderOverlays,
} from "./playbooks/resolver.js"
export type {
  ResolveContext,
  ResolveResult,
  ResolvedOverlay,
  RenderedOverlays,
} from "./playbooks/resolver.js"
export {
  PlaybookLifecycle,
  PlaybookNotFoundError,
  IllegalPlaybookTransitionError,
} from "./playbooks/lifecycle.js"
export type {
  PlaybookLifecycleOptions,
  ActivateResult,
  ArchiveResult,
} from "./playbooks/lifecycle.js"
export type {
  Playbook,
  PlaybookCorpusMeta,
  PlaybookKind,
  PlaybookQuery,
  PlaybookStatus,
  PlaybookTarget,
  PlaybookTargetKind,
} from "./playbooks/types.js"
export { PlaybookEvaluator } from "./playbooks/evaluator.js"
export type {
  EvalCase,
  PlaybookBatchOptions,
  PlaybookBatchResult,
  PlaybookEvaluatorOptions,
} from "./playbooks/evaluator.js"

