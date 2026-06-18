/**
 * plan — the auto-outliner. Turns (brief + dataset facets + profile) into a
 * chapter outline, so a report can run from a topic with NO hand-authored
 * config. Model-driven; the returned chapters are zod-validated and carry the
 * routing fields (facets/kw/cap) the pack builder needs.
 */

import { z } from "zod"
import { reportChapterSchema, type ReportChapter } from "./types.js"
import { type ReportModelPort, runModel } from "./model.js"

export interface PlanOutlineOptions {
  /** The research brief / framing (what the report should cover). */
  readonly brief: string
  /** Facets discovered in the dataset (the tags chapters route against). */
  readonly facets: readonly string[]
  /** Profile preset that shapes the unit (bible | brief | memo | deck). */
  readonly profile?: string
  /** Target chapter count (a hint, not a hard cap). */
  readonly targetChapters?: number
  readonly model: ReportModelPort
}

const planSchema = z.object({
  title: z.string().optional(),
  chapters: z.array(reportChapterSchema).min(1),
})

export interface PlanOutlineResult {
  readonly title?: string
  readonly chapters: readonly ReportChapter[]
}

/** Best-effort extraction of a JSON object from a model completion. */
function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  const body = fenced ? fenced[1]! : text
  const start = body.indexOf("{")
  const end = body.lastIndexOf("}")
  if (start === -1 || end === -1) throw new Error("plan: no JSON object in completion")
  return JSON.parse(body.slice(start, end + 1))
}

export async function planOutline(
  opts: PlanOutlineOptions
): Promise<PlanOutlineResult> {
  const profile = opts.profile ?? "bible"
  const target = opts.targetChapters ?? 8
  const text = await runModel(opts.model, {
    system:
      "You are a research editor planning a long-form, citation-backed report. " +
      "Output ONLY a JSON object — no prose, no fences.",
    prompt:
      `Plan a "${profile}" report from this brief and the available dataset facets.\n\n` +
      `BRIEF:\n${opts.brief}\n\n` +
      `DATASET FACETS (chapters route against these tags):\n${opts.facets.join(", ")}\n\n` +
      `Return JSON: { "title": string, "chapters": [ { "id": kebab-id, "title": "N. Heading", ` +
      `"facets": [subset of the facets above], "kw": [keyword needles], "cap": number, ` +
      `"words": "min-max", "cover": "1-2 sentence writer brief" } ] }.\n` +
      `Aim for about ${target} chapters. Every chapter MUST list at least one facet from the list.`,
  })
  const parsed = planSchema.parse(extractJson(text))
  return { ...(parsed.title ? { title: parsed.title } : {}), chapters: parsed.chapters }
}
