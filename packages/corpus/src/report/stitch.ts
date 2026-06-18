/**
 * stitchReport — assemble the final REPORT.md = front + part dividers +
 * chapters + annexes + a Sources section (from the global bibliography), per
 * the config's `parts[]`. Pure: reads report-side files through an injected
 * FsPort and RETURNS the document string (the caller writes REPORT.md).
 *
 * It is the markdown render medium: `stitchReport === reportContentToMarkdown
 * ∘ collectReportSections`. The shared section collection guarantees the
 * markdown medium and every `render.*` tool see the exact same boundaries.
 *
 * All reads are report-side (chapters + views) — the dataset is not touched.
 */

import { collectReportSections, reportContentToMarkdown } from "./content.js"
import type { CollectSectionsOptions } from "./content.js"

export type StitchOptions = CollectSectionsOptions

export interface StitchResult {
  readonly content: string
  readonly wordCount: number
}

export async function stitchReport(opts: StitchOptions): Promise<StitchResult> {
  const sections = await collectReportSections(opts)
  const content = reportContentToMarkdown(sections)
  const wordCount = sections
    .map((s) => s.markdown)
    .join(" ")
    .split(/\s+/).length
  return { content, wordCount }
}
