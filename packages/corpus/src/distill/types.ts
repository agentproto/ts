/**
 * Distill — raw source → refined knowledge entries (the KNOWLEDGE layer).
 *
 * The "simple mode": no graph engine. A refined entry is just an AIP-10
 * `knowledge.entry/v1` markdown file whose `sources: [<id>]` frontmatter
 * IS the `derivedFrom` provenance edge. The filesystem refs ARE the graph;
 * a graph engine (mind-graph / gbrain) is an optional index added later.
 *
 * The kit owns the contract + the runner (what to write, where, with what
 * provenance). The LLM that actually extracts insights is an injected
 * `DistillPort` — host-supplied (Claude/OpenAI), so the kit stays pure.
 */

import { z } from "zod"

/** Generic AIP-10 refined kinds — NOT domain-specific. */
export const REFINED_KIND_SCHEMA = z.enum([
  "principle",
  "pattern",
  "critique",
  "summary",
  "example",
])

export type RefinedKind = z.infer<typeof REFINED_KIND_SCHEMA>

/** Runtime guard — narrows an untyped value to RefinedKind without a cast. */
export function isRefinedKind(value: unknown): value is RefinedKind {
  return REFINED_KIND_SCHEMA.safeParse(value).success
}

export interface DistilledItem {
  readonly kind: RefinedKind
  readonly title: string
  /** The refined insight, markdown. Self-contained, not a quote dump. */
  readonly body: string
  /** 0–1 model confidence. */
  readonly confidence?: number
  readonly tags?: readonly string[]
}

export interface DistillInput {
  readonly title: string
  readonly body: string
  readonly tags?: readonly string[]
  /** Hint for the kinds worth extracting (e.g. only principles). */
  readonly kinds?: readonly RefinedKind[]
  /**
   * Lens instruction — an extra "what to look for under this aspect" directive
   * prepended to the base distill prompt. When set, distillation reads the
   * source THROUGH a lens (e.g. "extract marketing decisions and positioning")
   * instead of the generic durable-insight pass. See {@link Lens}.
   */
  readonly instruction?: string
}

/**
 * The LLM boundary. Given a raw source, return refined items. Injected by
 * the host (corpus-cli `AnthropicDistiller`, a Guilde operator, …) so the
 * kit takes no model dependency.
 */
export interface DistillPort {
  distill(input: DistillInput): Promise<readonly DistilledItem[]>
}

/**
 * Optional capability alongside `DistillPort`: distill many sources in one
 * call, keyed by a caller-supplied `key` (not by position — a batch-backed
 * implementation returns results in arbitrary order). A port that can't
 * batch simply doesn't implement this; callers check with {@link
 * hasDistillMany} rather than assuming every `DistillPort` has it.
 */
export interface DistillBatchPort {
  distillMany(
    inputs: ReadonlyArray<{ readonly key: string; readonly input: DistillInput }>
  ): Promise<ReadonlyMap<string, readonly DistilledItem[]>>
}

/** Runtime guard — narrows a `DistillPort` to one that also implements
 *  `DistillBatchPort`, without a cast. */
export function hasDistillMany(port: DistillPort): port is DistillPort & DistillBatchPort {
  return "distillMany" in port && typeof port.distillMany === "function"
}
