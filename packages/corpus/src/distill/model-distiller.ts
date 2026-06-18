/**
 * modelDistiller — a {@link DistillPort} backed by any structural model port
 * (`complete({prompt}) → {result}`). This is the seam that unifies distill with
 * the report writer: both are `buildPrompt → model.complete → parse`, so the
 * SAME executor (an API ModelPort, or `makeAgentCliModel(runtime)` over ANY
 * AIP-45 agent CLI — Hermes, claude-code, opencode, codex …) drives both.
 *
 * Owns only the distill-specific glue (the shared prompt + tolerant parse); the
 * model supplies the transport. Pure — no HTTP, no child process. The CLI's
 * `--engine <id>` selection and the HTTP `AnthropicDistiller` are now two
 * instances of the same shape.
 */

import { buildDistillPrompt, parseItems } from "./prompt.js"
import type { DistillInput, DistillPort, DistilledItem } from "./types.js"
import type { ReportModelPort } from "../report/model.js"

export interface ModelDistillerOptions {
  /** Max distilled items requested per source. Default 8. */
  maxItems?: number
}

/** Wrap a structural model port as a DistillPort (prompt → complete → parse). */
export function modelDistiller(
  model: ReportModelPort,
  opts: ModelDistillerOptions = {}
): DistillPort {
  const maxItems = opts.maxItems ?? 8
  return {
    async distill(input: DistillInput): Promise<readonly DistilledItem[]> {
      const prompt = buildDistillPrompt(input, maxItems)
      const { result } = await model.complete({ prompt })
      const text = typeof result === "string" ? result : JSON.stringify(result)
      return parseItems(text)
    },
  }
}
