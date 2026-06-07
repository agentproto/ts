/**
 * ClaudeDistiller — a `DistillPort` backed by Claude over the Messages API.
 * Reuses the kit's shared prompt + tolerant parse (`buildDistillPrompt` /
 * `parseItems`), owning only the HTTP transport. SDK-free (raw fetch) so the
 * job takes no client-lib dependency.
 *
 * Vendor-neutral: the only host coupling is an injected `apiKey` / `model` /
 * `baseUrl` — no app names, no env-name assumptions. Distillation is bulk +
 * background, so a mid-tier model is the sensible default; the caller gates
 * the spend (consent + incremental windows).
 */

import { z } from "zod"
import { buildDistillPrompt, parseItems } from "./prompt.js"
import type { DistillInput, DistilledItem, DistillPort } from "./types.js"

/** The Messages API response shape we read (just the text content blocks). */
const ANTHROPIC_RESPONSE = z
  .object({
    content: z
      .array(
        z.object({ type: z.string(), text: z.string().optional() }).loose()
      )
      .optional(),
  })
  .loose()

export interface ClaudeDistillerOptions {
  readonly apiKey: string
  /** Defaults to a mid-tier model — distillation is bulk + background. */
  readonly model?: string
  readonly baseUrl?: string
  /** Max refined items to extract per source. */
  readonly maxItems?: number
}

export class ClaudeDistiller implements DistillPort {
  private readonly apiKey: string
  private readonly model: string
  private readonly baseUrl: string
  private readonly maxItems: number

  constructor(opts: ClaudeDistillerOptions) {
    this.apiKey = opts.apiKey
    this.model = opts.model ?? "claude-sonnet-4-6"
    this.baseUrl = (opts.baseUrl ?? "https://api.anthropic.com/v1").replace(
      /\/+$/,
      ""
    )
    this.maxItems = opts.maxItems ?? 8
  }

  async distill(input: DistillInput): Promise<readonly DistilledItem[]> {
    const prompt = buildDistillPrompt(input, this.maxItems)
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
      throw new Error(
        `Claude distill ${res.status}: ${(await res.text()).slice(0, 200)}`
      )
    }
    const parsed = ANTHROPIC_RESPONSE.safeParse(await res.json())
    const text = parsed.success
      ? ((parsed.data.content ?? []).find(c => c.type === "text")?.text ?? "")
      : ""
    return parseItems(text)
  }
}
