/**
 * @agentproto/corpus/report — the report engine lib.
 *
 * Pure, port-injected logic that turns a corpus dataset (sources/ + entries/)
 * into a long-form report: views (L2 marts) here; plan/analyze/write/assemble
 * to follow. Render stays a separate canvakit driver (never imported here).
 */

export { buildPacks } from "./packs.js"
export type {
  BuildPacksOptions,
  BuildPacksResult,
  PackFile,
} from "./packs.js"

export { citesOf, outOfRangeCites } from "./cites.js"

export { assembleChapters, cleanDraft } from "./assemble.js"
export type {
  AssembleOptions,
  AssembleResult,
  ChapterDraft,
} from "./assemble.js"

export { stitchReport } from "./stitch.js"
export type { StitchOptions, StitchResult } from "./stitch.js"

// Medium-agnostic content — the single input every `render.*` tool consumes.
export {
  buildReportContent,
  collectReportSections,
  reportContentToMarkdown,
  reportContentSchema,
  reportSectionSchema,
  reportSectionKindSchema,
  bibEntrySchema,
} from "./content.js"
export type {
  ReportContent,
  ReportSection,
  BibEntry,
  BuildReportContentOptions,
  CollectSectionsOptions,
} from "./content.js"

export { applyEdits } from "./apply-edits.js"
export type {
  ApplyEditsOptions,
  ApplyEditsResult,
  ChapterEdit,
  ChapterEditSet,
} from "./apply-edits.js"

// Model steps — the single-pass "model driver" tier. Prompt-builders are pure
// and exported so the claude-code driver reuses them verbatim.
export { runModel } from "./model.js"
export type {
  ReportModelPort,
  ReportModelInput,
  ReportModelOutput,
} from "./model.js"

export { analyzeDataset, buildFacetAnalysisPrompt } from "./analyze.js"
export type {
  AnalyzeDatasetOptions,
  AnalyzeDatasetResult,
  AnalyzeFacetInput,
} from "./analyze.js"

export { writeChapter, buildChapterWritePrompt } from "./write.js"
export type { ChapterWriteContext } from "./write.js"

export { planOutline } from "./plan.js"
export type { PlanOutlineOptions, PlanOutlineResult } from "./plan.js"

export {
  reportConfigSchema,
  reportChapterSchema,
  reportCoverSchema,
  reportCoverPageSchema,
  reportCoverFactSchema,
  reportPartSchema,
} from "./types.js"
export type {
  ReportConfig,
  ReportChapter,
  ReportCover,
  ReportCoverPage,
  ReportCoverFact,
  ReportPart,
} from "./types.js"
