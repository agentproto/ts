/**
 * review — the single-pass chapter reviewer (the "model driver" tier of the
 * quality loop). Given a chapter's current prose, its per-facet analysis, and
 * the bibliography, the model returns a set of EXACT-MATCH `{find, replace,
 * reason}` edits that `applyEdits` can land verbatim (fact/citation fixes,
 * overstatement trims). It never rewrites the chapter — only proposes targeted,
 * verifiable edits, so the fix step stays deterministic.
 *
 * `buildReviewPrompt` is pure + exported so the claude-code driver reuses it.
 */

import { z } from "zod"
import type { ChapterEdit, ChapterEditSet } from "./apply-edits.js"
import { type ReportModelPort, type ReportModelInput, runModel } from "./model.js"

export interface ChapterReviewContext {
  readonly chapter: { readonly id: string; readonly title: string }
  /** The chapter's current markdown (what gets reviewed). */
  readonly chapterText: string
  /** Concatenated per-facet analysis docs (the ground truth to check against). */
  readonly analysisContext?: string
  /** The global bibliography markdown (citation range + targets). */
  readonly bibliography?: string
  /** Highest valid citation [n] — replacements must not exceed it. */
  readonly bibMax: number
  /**
   * Global rules block (`ReportConfig.rulesText`) — the same contract the
   * writer was given, appended verbatim so review enforces it too.
   */
  readonly rules?: string
}

export function buildReviewPrompt(ctx: ChapterReviewContext): ReportModelInput {
  return {
    system:
      "You are a meticulous fact + citation reviewer for a long-form research report. " +
      "Propose ONLY targeted, exact-match edits — never a rewrite. Each edit's `find` " +
      "MUST be a verbatim substring of the chapter that occurs EXACTLY ONCE, and " +
      "`replace` must keep every citation [n] within the valid range. Fix wrong/missing " +
      "citations, unsupported or overstated claims, and factual errors against the " +
      "analysis + bibliography. Output ONLY a JSON object — no prose, no fences." +
      (ctx.rules ? `\n\n${ctx.rules}` : ""),
    prompt:
      `Review the chapter "${ctx.chapter.title}". Valid citations are [1]..[${ctx.bibMax}].\n\n` +
      `## Chapter (current text):\n\n${ctx.chapterText}\n\n` +
      (ctx.analysisContext
        ? `## Per-facet analysis (ground truth):\n\n${ctx.analysisContext}\n\n`
        : "") +
      `## Bibliography:\n\n${ctx.bibliography ?? ""}\n\n` +
      `Return JSON: { "edits": [ { "find": "<verbatim once-occurring span>", ` +
      `"replace": "<corrected span>", "reason": "<short why>" } ] }. ` +
      `Return { "edits": [] } if the chapter is clean.`,
  }
}

const reviewSchema = z.object({
  edits: z
    .array(
      z.object({
        find: z.string().optional(),
        replace: z.string().optional(),
        reason: z.string().optional(),
      })
    )
    .default([]),
})

/** Best-effort extraction of a JSON object from a model completion. */
function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  const body = fenced ? fenced[1]! : text
  const start = body.indexOf("{")
  const end = body.lastIndexOf("}")
  if (start === -1 || end === -1) return { edits: [] }
  try {
    return JSON.parse(body.slice(start, end + 1))
  } catch {
    return { edits: [] }
  }
}

/**
 * Single-pass chapter review → a {@link ChapterEditSet} ready for
 * `applyEdits`. Tolerant: a malformed completion yields no edits (the chapter
 * is left untouched) rather than throwing — review is an enhancement, not a gate.
 */
export async function reviewChapter(
  ctx: ChapterReviewContext,
  model: ReportModelPort
): Promise<ChapterEditSet> {
  const text = await runModel(model, buildReviewPrompt(ctx))
  const parsed = reviewSchema.safeParse(extractJson(text))
  const edits: ChapterEdit[] = parsed.success ? parsed.data.edits : []
  return { id: ctx.chapter.id, edits }
}
