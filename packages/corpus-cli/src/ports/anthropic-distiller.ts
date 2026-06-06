/**
 * AnthropicDistiller — a DistillPort backed by Claude. Extracts refined
 * AIP-10 items (generic kinds: principle/pattern/critique/summary/example)
 * from a raw source. Returns self-contained insights, not quote dumps.
 *
 * Hand-rolled over the Anthropic Messages API (no SDK dep), mirroring the
 * other corpus-cli port adapters. Asks for a JSON array and parses it.
 */

import { z } from "zod"
import {
  REFINED_KIND_SCHEMA,
  type DistillPort,
  type DistillInput,
  type DistilledItem,
} from "@agentproto/corpus"

/** The Messages API response shape we read (just the text content blocks). */
const ANTHROPIC_RESPONSE = z
  .object({
    content: z
      .array(z.object({ type: z.string(), text: z.string().optional() }).loose())
      .optional(),
  })
  .loose()

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

export interface AnthropicDistillerOptions {
  readonly apiKey: string
  /** Default a current Claude model id. */
  readonly model?: string
  readonly baseUrl?: string
  /** Max refined items to extract per source. */
  readonly maxItems?: number
}

export class AnthropicDistiller implements DistillPort {
  private readonly apiKey: string
  private readonly model: string
  private readonly baseUrl: string
  private readonly maxItems: number

  constructor(opts: AnthropicDistillerOptions) {
    this.apiKey = opts.apiKey
    this.model = opts.model ?? "claude-sonnet-4-6"
    this.baseUrl = (opts.baseUrl ?? "https://api.anthropic.com/v1").replace(/\/+$/, "")
    this.maxItems = opts.maxItems ?? 8
  }

  async distill(input: DistillInput): Promise<readonly DistilledItem[]> {
    const prompt = `You distill a raw source (a video transcript or article) into REFINED, reusable knowledge for an AI operator. Extract the durable insights — not a summary of the video, but the transferable lessons.

Return a JSON array (max ${this.maxItems} items). Each item:
{ "kind": one of "principle" | "pattern" | "critique" | "summary" | "example",
  "title": short imperative/declarative title,
  "body": 2-5 sentences, SELF-CONTAINED (no "the speaker says"), the actual insight,
  "confidence": 0-1, "tags": [short topic tags] }

Guidance:
- "principle": a durable rule of thumb. "pattern": a repeatable technique/sequence.
  "critique": a common mistake / anti-pattern. "summary": a compact overview.
  "example": a concrete worked instance worth remembering.
- Drop filler, calls-to-action, tangents. Keep only what an operator could ACT on later.
- Write body in the source's own language.

SOURCE TITLE: ${input.title}
${input.tags?.length ? `TAGS: ${input.tags.join(", ")}\n` : ""}
SOURCE BODY:
${input.body.slice(0, 24000)}

Return ONLY the JSON array, no prose.`

    const res = await fetch(`${this.baseUrl}/messages`, {
      method: "POST",
      headers: {
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: 4096,
        messages: [{ role: "user", content: prompt }],
      }),
    })
    if (!res.ok) {
      throw new Error(`Anthropic distill ${res.status}: ${(await res.text()).slice(0, 200)}`)
    }
    const parsed = ANTHROPIC_RESPONSE.safeParse(await res.json())
    const text = parsed.success
      ? (parsed.data.content ?? []).find(c => c.type === "text")?.text ?? ""
      : ""
    return parseItems(text)
  }
}

function parseItems(text: string): DistilledItem[] {
  // Tolerate ```json fences or leading prose — grab the first [...] block.
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
