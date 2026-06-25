/**
 * AnthropicDistiller — a DistillPort backed by Claude over the Messages API.
 * Extracts refined AIP-10 items (principle/pattern/critique/summary/example)
 * from a raw source. Returns self-contained insights, not quote dumps.
 *
 * Hand-rolled over the HTTP API (no SDK dep), mirroring the other corpus-cli
 * port adapters. Prompt + parse are the shared `distill-prompt` core; this
 * adapter owns only the metered-API transport. For the subscription-billed
 * alternative see CliAgentDistiller + the `claude-code` engine.
 */

import { z } from "zod"
import type { DistillPort, DistillInput, DistilledItem } from "@agentproto/corpus"
import { buildDistillPrompt, parseItems } from "./distill-prompt.js"
import type { DistillUsage } from "./usage-telemetry.js"

/** The Messages API response — text content blocks plus model + token usage. */
const ANTHROPIC_RESPONSE = z
  .object({
    model: z.string().optional(),
    content: z
      .array(z.object({ type: z.string(), text: z.string().optional() }).loose())
      .optional(),
    usage: z
      .object({ input_tokens: z.number(), output_tokens: z.number() })
      .loose()
      .optional(),
  })
  .loose()

export interface AnthropicDistillerOptions {
  readonly apiKey: string
  /** Default a current Claude model id. */
  readonly model?: string
  readonly baseUrl?: string
  /** Max refined items to extract per source. */
  readonly maxItems?: number
  /** Optional sink for per-call token usage (cost + Langfuse export). */
  readonly onUsage?: (usage: DistillUsage) => void
  /** Output language code (e.g. "fr"). Absent → English (default). */
  readonly lang?: string
}

export class AnthropicDistiller implements DistillPort {
  private readonly apiKey: string
  private readonly model: string
  private readonly baseUrl: string
  private readonly maxItems: number
  private readonly onUsage: ((usage: DistillUsage) => void) | undefined
  private readonly lang: string | undefined

  constructor(opts: AnthropicDistillerOptions) {
    this.apiKey = opts.apiKey
    this.model = opts.model ?? "claude-sonnet-4-6"
    this.baseUrl = (opts.baseUrl ?? "https://api.anthropic.com/v1").replace(/\/+$/, "")
    this.maxItems = opts.maxItems ?? 8
    this.onUsage = opts.onUsage
    this.lang = opts.lang
  }

  async distill(input: DistillInput): Promise<readonly DistilledItem[]> {
    const prompt = buildDistillPrompt(input, this.maxItems, { lang: this.lang })
    const startedAt = new Date().toISOString()
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
    if (parsed.success && parsed.data.usage && this.onUsage) {
      this.onUsage({
        model: parsed.data.model ?? this.model,
        inputTokens: parsed.data.usage.input_tokens,
        outputTokens: parsed.data.usage.output_tokens,
        label: input.title,
        startedAt,
        endedAt: new Date().toISOString(),
      })
    }
    return parseItems(text)
  }
}
