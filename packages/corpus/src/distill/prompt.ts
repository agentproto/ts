/**
 * Shared distill prompt + parse — the model-agnostic core of distillation.
 *
 * Every DistillPort backend (an HTTP Messages-API distiller, a CLI-agent
 * distiller, an in-app model adapter) asks the same thing and reads the same
 * shape back, so the prompt and the tolerant JSON parse live here once. A
 * backend owns only the transport (HTTP vs. child process vs. SDK) and how it
 * extracts the model's text.
 */

import { z } from "zod"
import {
  REFINED_KIND_SCHEMA,
  type DistillInput,
  type DistilledItem,
} from "./types.js"

/** A single distilled item as the model is asked to emit it. */
const DISTILLED_ITEM = z
  .object({
    kind: REFINED_KIND_SCHEMA,
    title: z.string(),
    body: z.string(),
    confidence: z.number().optional(),
    tags: z.array(z.string()).optional(),
  })
  .loose()

/** Well-known language codes → display names for the prompt instruction. */
const LANG_NAMES: Readonly<Record<string, string>> = {
  en: "ENGLISH", fr: "FRENCH", de: "GERMAN", es: "SPANISH",
  pt: "PORTUGUESE", it: "ITALIAN", nl: "DUTCH", ja: "JAPANESE",
  zh: "CHINESE", ko: "KOREAN", ru: "RUSSIAN", ar: "ARABIC",
  pl: "POLISH", sv: "SWEDISH", tr: "TURKISH",
}

function langName(code: string | undefined): string {
  if (!code) return "ENGLISH"
  return LANG_NAMES[code.toLowerCase()] ?? code.toUpperCase()
}

/** Build the distillation prompt for one source, capped at `maxItems`. */
export function buildDistillPrompt(
  input: DistillInput,
  maxItems: number,
  opts?: { readonly lang?: string }
): string {
  // A lens narrows the extraction to one aspect; without one, the generic
  // durable-insight pass runs (back-compat — existing callers pass no lens).
  const lensBlock = input.instruction?.trim()
    ? `LENS — read the source THROUGH this aspect, extract ONLY what serves it:\n${input.instruction.trim()}\n\n`
    : ""
  // A lens may restrict which kinds are valid; default to the full set.
  const kinds = input.kinds?.length
    ? input.kinds
    : (["principle", "pattern", "critique", "summary", "example"] as const)
  const kindUnion = kinds.map(k => `"${k}"`).join(" | ")

  return `${lensBlock}You distill a raw source (a video transcript or article) into REFINED, reusable knowledge for an AI operator. Extract the durable insights — not a summary of the video, but the transferable lessons.

Return a JSON array (max ${maxItems} items). Each item:
{ "kind": one of ${kindUnion},
  "title": short imperative/declarative title,
  "body": 2-5 sentences, SELF-CONTAINED (no "the speaker says"), the actual insight,
  "confidence": 0-1, "tags": [short topic tags] }

Guidance:
- "principle": a durable rule of thumb. "pattern": a repeatable technique/sequence.
  "critique": a common mistake / anti-pattern. "summary": a compact overview.
  "example": a concrete worked instance worth remembering.
- Drop filler, calls-to-action, tangents. Keep only what an operator could ACT on later.
- Write every title and body in ${langName(opts?.lang)}, even when the source is in another language. Translate the insight; do not copy the source language.

SOURCE TITLE: ${input.title}
${input.tags?.length ? `TAGS: ${input.tags.join(", ")}\n` : ""}SOURCE BODY:
${input.body.slice(0, 24000)}

Return ONLY the JSON array, no prose.`
}

/** Tolerant parse: grab the first `[...]` block (allows ```json fences / prose). */
export function parseItems(text: string): DistilledItem[] {
  const start = text.indexOf("[")
  const end = text.lastIndexOf("]")
  if (start < 0 || end <= start) return []
  let raw: unknown
  try {
    raw = JSON.parse(text.slice(start, end + 1))
  } catch {
    return []
  }
  if (!Array.isArray(raw)) return []
  const out: DistilledItem[] = []
  for (const r of raw) {
    const item = DISTILLED_ITEM.safeParse(r)
    if (!item.success) continue
    const { kind, title, body, confidence, tags } = item.data
    out.push({
      kind,
      title,
      body,
      ...(typeof confidence === "number" ? { confidence } : {}),
      ...(tags ? { tags } : {}),
    })
  }
  return out
}
