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

export { applyEdits } from "./apply-edits.js"
export type {
  ApplyEditsOptions,
  ApplyEditsResult,
  ChapterEdit,
  ChapterEditSet,
} from "./apply-edits.js"

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
