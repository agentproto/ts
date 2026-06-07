/**
 * Character distill profile — the prompt that turns a person's own posts
 * into durable CHARACTER signal, mapped onto the generic AIP-10 refined
 * kinds the corpus DistillRunner already writes. Pure: just the prompt +
 * a tolerant parse; the host owns the LLM transport (a DistillPort).
 *
 * The mapping (so synth/footprint-to-persona can read entries back):
 *   summary   → voice: register, tone, signature phrases, how they sound
 *   principle → beliefs: claims/opinions they repeat and stand behind
 *   pattern   → behaviour: how they argue, post, build, engage (cadence)
 *   critique  → boundaries: what they push back on / refuse / dislike
 *   example   → lore: a concrete story/launch/moment worth remembering
 */

import type { DistillInput, DistilledItem } from "@agentproto/corpus"

/** Tag every character entry carries — lets synth + queries select them. */
export const CHARACTER_TAG = "character"

/** Build the character-distillation prompt for one source (a post or batch). */
export function buildCharacterDistillPrompt(
  input: DistillInput,
  maxItems: number,
  handle?: string
): string {
  const who = handle ? `@${handle}` : "this person"
  return `You are profiling ${who} from their OWN social posts to build a faithful character knowledge base — the kind that could later power a digital twin that talks like them. Extract DURABLE character signal, not a summary of any single post.

Return a JSON array (max ${maxItems} items). Each item:
{ "kind": one of "summary" | "principle" | "pattern" | "critique" | "example",
  "title": short declarative title,
  "body": 2-5 sentences, SELF-CONTAINED (no "they posted"), the actual trait/belief in ${who}'s own register where possible,
  "confidence": 0-1, "tags": [short topic tags] }

What each kind captures for a CHARACTER:
- "summary"  → VOICE: register, tone, recurring phrasings, emoji/formatting habits, how they sound. Quote signature phrases verbatim in the body.
- "principle" → BELIEF: an opinion/claim they repeat and clearly stand behind. The conviction, stated as they'd state it.
- "pattern"  → BEHAVIOUR: how they operate — how they argue, what they post about, cadence, what they amplify.
- "critique" → BOUNDARY: what they push back on, dislike, refuse, or call out as wrong.
- "example"  → LORE: a concrete moment — a launch, a number, a story — worth remembering as part of who they are.

Rules:
- Only extract what is genuinely durable + characteristic. A throwaway post yields nothing — return fewer items, or an empty array.
- Preserve their actual wording and stance. Do NOT sanitize or neutralize opinions; faithfully capture even spiky takes.
- Write titles/bodies in the post's language; do not translate their voice.

SOURCE TITLE: ${input.title}
${input.tags?.length ? `TAGS: ${input.tags.join(", ")}\n` : ""}SOURCE BODY:
${input.body.slice(0, 24000)}

Return ONLY the JSON array, no prose.`
}

/** Tolerant parse — first `[…]` block, validated loosely into DistilledItems. */
export function parseCharacterItems(text: string): DistilledItem[] {
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
  const kinds = new Set(["summary", "principle", "pattern", "critique", "example"])
  const out: DistilledItem[] = []
  for (const r of raw) {
    if (!r || typeof r !== "object") continue
    const o = r as Record<string, unknown>
    if (typeof o.kind !== "string" || !kinds.has(o.kind)) continue
    if (typeof o.title !== "string" || typeof o.body !== "string") continue
    out.push({
      kind: o.kind as DistilledItem["kind"],
      title: o.title,
      body: o.body,
      ...(typeof o.confidence === "number" ? { confidence: o.confidence } : {}),
      tags: [
        CHARACTER_TAG,
        ...(Array.isArray(o.tags) ? o.tags.filter((t): t is string => typeof t === "string") : []),
      ],
    })
  }
  return out
}
