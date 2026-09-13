/**
 * write — the single-pass chapter writer (the "model driver" tier). Given a
 * chapter's view (distilled claims + [n] cites), the per-facet analysis, and
 * the bibliography, produce a cited markdown draft.
 *
 * `buildChapterWritePrompt` is pure and exported so the higher-fidelity
 * claude-code driver (Phase C) reuses the identical prompt while swapping the
 * executor for a file-reading sub-agent. `writeChapter` is the model-driver
 * executor. Output is a raw DRAFT — `assembleChapters` then cleans it.
 */

import type { ReportChapter } from "./types.js"
import { type ReportModelPort, type ReportModelInput, runModel } from "./model.js"

export interface ChapterWriteContext {
  readonly chapter: Pick<ReportChapter, "id" | "title" | "words" | "cover">
  /** Report/document title for framing. */
  readonly title: string
  /** The chapter's view content (distilled claims with [n]). */
  readonly packContent: string
  /** Concatenated per-facet analysis docs (optional deeper context). */
  readonly analysisContext?: string
  /** The global bibliography markdown (for citation verification). */
  readonly bibliography?: string
  /** Global rules block (`ReportConfig.rulesText`) — appended verbatim. */
  readonly rules?: string
  /** Sibling chapters (the caller filters out the current one) for cross-refs. */
  readonly outline?: ReadonlyArray<{ id: string; title: string }>
}

export function buildChapterWritePrompt(
  ctx: ChapterWriteContext
): ReportModelInput {
  const words = ctx.chapter.words ?? "800-1500"
  return {
    system:
      "You are an expert research writer. Write in clear, dense, well-structured prose. " +
      "Every non-obvious claim must be cited inline as [n] from the Bibliography. " +
      "Use Markdown H2 and H3 subheaders within the chapter. No meta-commentary or filler. " +
      `Aim for ${words} words.` +
      (ctx.rules ? `\n\n${ctx.rules}` : ""),
    prompt:
      `Write the chapter "${ctx.chapter.title}" for the research document "${ctx.title}".\n\n` +
      (ctx.chapter.cover
        ? `## Chapter brief (what this chapter must cover)\n\n${ctx.chapter.cover}\n\n`
        : "") +
      `## Distilled claims for this chapter (with citation numbers):\n\n${ctx.packContent}\n\n` +
      (ctx.analysisContext
        ? `## Per-facet analysis (for deeper context):\n\n${ctx.analysisContext}\n\n`
        : "") +
      `## Bibliography (for citation verification):\n\n${ctx.bibliography ?? ""}\n\n` +
      (ctx.outline && ctx.outline.length > 0
        ? `## Book outline (for forward/back references)\n\n${ctx.outline
            .map((o) => `- ${o.id}: ${o.title}`)
            .join("\n")}\n\nReference sibling chapters as [[chapter-id]] where helpful.\n\n`
        : "") +
      `Write the chapter now. Start with the "## ${ctx.chapter.title}" heading, then the content.`,
  }
}

/** Single-pass chapter write → a `{ ch, draft }` ready for assembleChapters. */
export async function writeChapter(
  ctx: ChapterWriteContext,
  model: ReportModelPort
): Promise<{ ch: string; draft: string }> {
  const draft = await runModel(model, buildChapterWritePrompt(ctx))
  return { ch: ctx.chapter.id, draft }
}
