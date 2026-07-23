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
export { ConversationImporter } from "./importers/conversation.js"
export { CodeImporter } from "./importers/code.js"
export { PrReviewImporter } from "./importers/pr-review.js"
export type {
  CorpusImporter,
  ImporterTarget,
  ImportedSource,
  BatchReport,
  ImporterRunnerOptions,
} from "./importers/types.js"
export type { LocalFilesImporterOptions } from "./importers/local-files.js"
export type { WebImporterOptions } from "./importers/web.js"
export type { ConversationImporterOptions } from "./importers/conversation.js"
export type { CodeImporterOptions } from "./importers/code.js"
export type { PrReviewImporterOptions } from "./importers/pr-review.js"

// Distill — raw source → refined entries (KNOWLEDGE layer)
export { DistillRunner } from "./distill/runner.js"
export type {
  DistillRunnerOptions,
  DistillSource,
  DistillRunReport,
  EntryLayout,
} from "./distill/runner.js"
export type {
  DistillPort,
  DistillInput,
  DistilledItem,
  RefinedKind,
} from "./distill/types.js"
export { REFINED_KIND_SCHEMA, isRefinedKind } from "./distill/types.js"
export { buildDistillPrompt, parseItems } from "./distill/prompt.js"
export { scanDistilledSourceIds } from "./distill/scan.js"
// Source scan — sources/**​/*.md → DistillSource[] (frontmatter-id provenance,
// frontmatter-stripped body). The single impl shared by the Bureau client
// driver and the server-side synthesize payoff (no client/server drift).
export { readDistillSources } from "./distill/read-sources.js"
export type { ReadDistillSourcesOptions } from "./distill/read-sources.js"
// Model-backed distiller — any structural ModelPort (incl. an agent CLI via
// makeAgentCliModel) becomes a DistillPort. Unifies distill with the report writer.
export { modelDistiller } from "./distill/model-distiller.js"
export type { ModelDistillerOptions } from "./distill/model-distiller.js"

// Distill registry — the catalog of distill kinds (4 swappable slots per
// descriptor) + the generic per-(descriptor × scope) runner.
export { createDistillRegistry } from "./distill/registry.js"
export type {
  DistillRegistry,
  DistillDescriptor,
  DistillBinding,
  DistillScope,
  DistillTarget,
} from "./distill/registry.js"
export { runDistill } from "./distill/run.js"
export type { DistillReport, RunDistillOptions } from "./distill/run.js"
// The shared import → distill core that both cron (runDistill) and the
// standalone CLI / runtime tool ride on.
export { distillFromImporter } from "./distill/generate.js"
export type {
  DistillCoreReport,
  DistillFromImporterOptions,
} from "./distill/generate.js"
// DistillIndex — the persistent "what was distilled when" ledger sidecar.
export { DistillIndex, DISTILL_INDEX_PATH } from "./distill/distill-index.js"
export type {
  DistillIndexRecord,
  DistillIndexOptions,
} from "./distill/distill-index.js"
// Lens — a named, time-aware projection over the shared source pool.
export { lensAspect, lensAspectTag } from "./distill/lens.js"
export type { Lens, LensMode, SourceSelector } from "./distill/lens.js"
// Synthesis — the mode:"synthesis" rebuild (current atoms → consolidated artifact).
export {
  synthesizeLens,
  currentLensAtoms,
  lensSynthesisStale,
  defaultSynthesisPath,
  buildSynthesisPrompt,
  SYNTHESIS_ROLE_TAG,
} from "./distill/synthesize.js"
export type {
  SynthesisPort,
  SynthesisInput,
  SynthesisAtom,
  SynthesizeLensOptions,
  SynthesizeLensReport,
  LensStaleness,
} from "./distill/synthesize.js"

// ClaudeDistiller — a DistillPort over the Messages API (host-injected key).
export { ClaudeDistiller } from "./distill/claude-distiller.js"
export type { ClaudeDistillerOptions } from "./distill/claude-distiller.js"

// Conversation windowing — pure (thread, day) helpers + the windowed-source
// contract the conversation kind binds against.
export {
  windowRef,
  parseWindowRef,
  windowSlug,
  enumerateWindowRefs,
} from "./distill/windows.js"
export type {
  ConversationWindowSource,
  ConversationThreadRef,
} from "./distill/windows.js"

// Knowledge resolver — the `knowledge:` binding (KNOWLEDGE → SKILL link)
export { resolveKnowledge } from "./knowledge/resolve.js"
export type {
  CorpusEntryQuery,
  ResolvedEntry,
  SourceRef,
  ResolveKnowledgeOptions,
} from "./knowledge/resolve.js"

// Overlay — guild edits shadow read-only packs (the customization engine)
export {
  OverlayFs,
  ReadOnlyFs,
  WHITEOUT_SUFFIX,
  type OverlayFsOptions,
} from "./knowledge/overlay-fs.js"

// In-memory FsPort — backs build-time-inlined knowledge packs (no runtime fs)
export { MemFs } from "./knowledge/mem-fs.js"

// Knowledge stack — composable layer resolution (register one provider per
// dimension; resolver emits a band-ordered stack; mount helper overlays it)
export {
  StackResolver,
  buildOverlayFromStack,
  flattenPackRefs,
  partitionStackRefs,
  type BuildOverlayOptions,
  type StackRefPartition,
  type LayerMode,
  type LayerRef,
  type LayerProvider,
  type LayerShadow,
  type ResolutionContext,
  type StackEntry,
  type StackResolution,
  type StackSkip,
} from "./stack/index.js"

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
export type {
  ConversationSourcePort,
  ConversationDoc,
  ConversationTurn,
} from "./ports/conversation-source.port.js"
export type {
  PrSourcePort,
  PrDoc,
  PrQuery,
  PrReviewComment,
} from "./ports/pr-source.port.js"
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
  PushSourceInput,
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

// Attachment binding plane — Dimensions × Selectors × one matcher
export {
  ANY_REF,
  WELL_KNOWN_AXES,
  createAxisRegistry,
  identityAxis,
  roleAxis,
  positionAxis,
  capabilityAxis,
  prefixedRefNormalizer,
  EMPTY_SELECTOR,
  isEmptySelector,
  matchesSelector,
  parseSelectorFrontmatter,
  compileLegacyPlaybookBinding,
  matchAttachments,
  matchAttachmentRefs,
} from "./binding/index.js"
export type {
  AxisDefinition,
  AxisRegistry,
  Dimensions,
  MatchOptions,
  Selector,
  SelectorTerm,
  AttachmentAsset,
  AttachmentDeclaration,
  MatchAttachmentsOptions,
} from "./binding/index.js"

// CorpusHost — the runtime wiring that attaches a corpus to a scope and
// makes its knowledge reachable to an agent's turn (Component A + B).
export type { CorpusHost } from "./host/index.js"
export { MemFsCorpusHost } from "./host/index.js"
export type {
  DimensionProvider,
  DimensionValue,
  StandardSubject,
} from "./host/index.js"
export { assembleDimensions, standardDimensionProvider } from "./host/index.js"

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

