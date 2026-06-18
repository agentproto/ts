/**
 * analyze — synthesize the distilled entries of each facet into a structured
 * markdown analysis doc (`sources.<facet>.md`), the deeper context the chapter
 * writer reads. A report-side step (invariant 3): it READS the dataset's
 * entries and RETURNS report-rooted files; it never writes the dataset.
 */

import type { FsPort } from "../ports/fs.port.js"
import { resolveKnowledge } from "../knowledge/resolve.js"
import type { PackFile } from "./packs.js"
import { type ReportModelPort, type ReportModelInput, runModel } from "./model.js"

export interface AnalyzeFacetInput {
  readonly facet: string
  /** Pre-rendered entries block (title/kind/confidence + body per entry). */
  readonly entriesText: string
}

/** The prompt for one facet's analysis doc — pure, driver-reusable. */
export function buildFacetAnalysisPrompt(
  input: AnalyzeFacetInput
): ReportModelInput {
  return {
    system:
      "You are a research analyst. Your output is a structured markdown analysis " +
      "document that will be used as input to a long-form research bible chapter. " +
      "Write in clear, dense prose with H2 headers. No filler, no meta-commentary.",
    prompt:
      `Synthesize these knowledge entries about the facet "${input.facet}" into a structured ` +
      `markdown analysis document for a research bible.\n\n` +
      `Include:\n` +
      `- ## Key Themes: recurring patterns across entries\n` +
      `- ## Major Findings: the most credible, high-confidence claims\n` +
      `- ## Notable Examples: concrete worked instances worth citing\n` +
      `- ## Gaps & Contradictions: what is unknown, disputed, or missing\n\n` +
      `ENTRIES:\n\n${input.entriesText}`,
  }
}

export interface AnalyzeDatasetOptions {
  /** Read-only view of the dataset (entries/). */
  readonly dataset: FsPort
  readonly facets: readonly string[]
  readonly model: ReportModelPort
}

export interface AnalyzeDatasetResult {
  /** `sources.<facet>.md` files to write at the report root. */
  readonly files: readonly PackFile[]
  readonly analyzed: number
  /** Facets skipped because they resolved to zero entries. */
  readonly skipped: readonly string[]
}

export async function analyzeDataset(
  opts: AnalyzeDatasetOptions
): Promise<AnalyzeDatasetResult> {
  const files: PackFile[] = []
  const skipped: string[] = []

  for (const facet of opts.facets) {
    const entries = await resolveKnowledge({
      fs: opts.dataset,
      query: { tags: [facet] },
    })
    if (entries.length === 0) {
      skipped.push(facet)
      continue
    }
    const entriesText = entries
      .map(
        (e) =>
          `### ${e.title} (${e.kind}, confidence ${e.confidence ?? "?"})\n\n${e.body}`
      )
      .join("\n\n---\n\n")
    const content = await runModel(
      opts.model,
      buildFacetAnalysisPrompt({ facet, entriesText })
    )
    files.push({
      path: `sources.${facet}.md`,
      content: `# Analysis: ${facet}\n\n${content}`,
    })
  }

  return { files, analyzed: files.length, skipped }
}
