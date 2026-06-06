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

/** Build the distillation prompt for one source, capped at `maxItems`. */
export function buildDistillPrompt(
  input: DistillInput,
  maxItems: number
): string {
  return `You distill a raw source (a video transcript or article) into REFINED, reusable knowledge for an AI operator. Extract the durable insights — not a summary of the video, but the transferable lessons.

Return a JSON array (max ${maxItems} items). Each item:
{ "kind": one of "principle" | "pattern" | "critique" | "summary" | "example",
  "title": short imperative/declarative title,
  "body": 2-5 sentences, SELF-CONTAINED (no "the speaker says"), the actual insight,
  "confidence": 0-1, "tags": [short topic tags] }

Guidance:
- "principle": a durable rule of thumb. "pattern": a repeatable technique/sequence.
  "critique": a common mistake / anti-pattern. "summary": a compact overview.
  "example": a concrete worked instance worth remembering.
- Drop filler, calls-to-action, tangents. Keep only what an operator could ACT on later.
- Write every title and body in ENGLISH, even when the source is in another language. Translate the insight; do not copy the source language.

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
