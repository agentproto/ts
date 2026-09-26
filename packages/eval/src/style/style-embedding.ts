import { z } from "zod"
import { defineTool } from "@agentproto/tool"
import { defineDriver, implementTool, type DriverHandle } from "@agentproto/driver"
import { scoreSchema } from "../score.js"

/**
 * `eval.style-embedding` — model-backed scorer: how close `candidate` sits
 * to the centroid of `references[]` in embedding space. The embedding
 * function is injected (`EmbedFn`, closed over by
 * {@link makeStyleEmbeddingDriver}) — this package has no model SDK and
 * makes no network call of its own, matching the `eval.llm-judge` /
 * `eval.style-pairwise` pattern.
 */

// ---------------------------------------------------------------------------
// cosineToCentroid — pure helper
// ---------------------------------------------------------------------------

function dot(a: readonly number[], b: readonly number[]): number {
  let sum = 0
  for (let i = 0; i < a.length; i++) sum += (a[i] ?? 0) * (b[i] ?? 0)
  return sum
}

function norm(v: readonly number[]): number {
  return Math.sqrt(dot(v, v))
}

/** Thrown by {@link centroid} / {@link cosineToCentroid} on mismatched embedding dimensions — callers crossing the tool boundary (the driver) must catch this and fail the `Score`, never let it propagate as a thrown error out of the tool contract. */
export class EmbeddingDimensionError extends RangeError {}

function centroid(vectors: readonly (readonly number[])[]): number[] {
  const dims = vectors[0]?.length ?? 0
  for (const v of vectors) {
    if (v.length !== dims) {
      throw new EmbeddingDimensionError(`inconsistent embedding dimensions: expected ${dims}, got ${v.length}`)
    }
  }
  const sum = new Array(dims).fill(0) as number[]
  for (const v of vectors) {
    for (let i = 0; i < dims; i++) sum[i] = (sum[i] ?? 0) + (v[i] ?? 0)
  }
  return sum.map((x) => x / vectors.length)
}

/**
 * Pure helper: cosine similarity between `candidate` and the centroid of
 * `references`, clamped to `[0, 1]` via `max(0, cosine)` — NOT remapped from
 * `[-1, 1]` via `(cosine + 1) / 2`. That remap put an orthogonal candidate
 * (cosine 0, no signal) at 0.5, the same value as the default `passed`
 * threshold, so an uninformative embedding silently cleared the gate. Under
 * `max(0, cosine)`, orthogonal and opposing candidates both score 0. A
 * candidate equal to the centroid still returns exactly 1.
 *
 * Throws {@link EmbeddingDimensionError} if `candidate` and the references'
 * centroid have different dimensionality — callers at the tool boundary must
 * catch this (see {@link makeStyleEmbeddingDriver}) rather than let it cross
 * into a thrown error from the TOOL contract.
 */
export function cosineToCentroid(candidate: readonly number[], references: readonly (readonly number[])[]): number {
  if (references.length === 0) return 0
  const c = centroid(references)
  if (candidate.length !== c.length) {
    throw new EmbeddingDimensionError(
      `inconsistent embedding dimensions: candidate has ${candidate.length}, references have ${c.length}`,
    )
  }
  const cn = norm(c)
  const vn = norm(candidate)
  if (cn === 0 || vn === 0) return 0
  const cosine = dot(candidate, c) / (vn * cn)
  return Math.max(0, Math.min(1, cosine))
}

// ---------------------------------------------------------------------------
// eval.style-embedding — the TOOL contract
// ---------------------------------------------------------------------------

export interface StyleEmbeddingInput {
  readonly candidate: string
  readonly references: readonly string[]
}

export const styleEmbeddingTool = defineTool({
  id: "eval.style-embedding",
  description:
    "Model-backed scorer: embeds `candidate` and `references[]` via an " +
    "injected EmbedFn and scores value = cosine similarity of `candidate` " +
    "to the references' centroid, clamped to [0, 1] via max(0, cosine) " +
    "(orthogonal or opposing candidates score 0, not 0.5). The embedding " +
    "call lives in the driver (see makeStyleEmbeddingDriver) — this tool " +
    "contract carries no model call of its own.",
  version: "0.1.0",
  inputSchema: z.object({
    candidate: z.string().describe("The text to score."),
    references: z.array(z.string()).min(1).describe("Reference texts defining the style centroid."),
  }),
  outputSchema: scoreSchema,
  mutates: [],
  approval: "auto",
  riskLevel: 0,
})

// ---------------------------------------------------------------------------
// makeStyleEmbeddingDriver — closes over the injected EmbedFn
// ---------------------------------------------------------------------------

/**
 * The seam a real embedding capability satisfies: given a batch of texts,
 * return one embedding vector per text, same order. Deliberately no model
 * SDK / network types here — vendor-neutral, like {@link JudgeFn}.
 */
export type EmbedFn = (texts: readonly string[]) => Promise<number[][]>

export interface MakeStyleEmbeddingDriverOptions {
  /** Minimum value to count as passed. Default 0.5. */
  readonly threshold?: number
}

/**
 * Build a DRIVER that implements `eval.style-embedding` by delegating to
 * `embed`. Embeds `[candidate, ...references]` in a single batch call so a
 * remote embedding backend sees one request per score.
 */
export function makeStyleEmbeddingDriver(embed: EmbedFn, opts?: MakeStyleEmbeddingDriverOptions): DriverHandle {
  const threshold = opts?.threshold ?? 0.5
  return defineDriver({
    id: "eval-style-embedding",
    name: "Eval Style Embedding (model-backed)",
    description:
      "Model-backed scorer driver: implements eval.style-embedding by " +
      "awaiting an injected EmbedFn and scoring cosine similarity of the " +
      "candidate to the references' centroid. No LLM SDK or network call here.",
    version: "0.1.0",
    kind: "builtin",
    implements: [{ tool: "eval.style-embedding", version: "0.1.0" }],
    implementations: [
      implementTool(styleEmbeddingTool, async ({ input }) => {
        const vectors = await embed([input.candidate, ...input.references])
        const [candidateVec, ...referenceVecs] = vectors
        let value: number
        try {
          value = cosineToCentroid(candidateVec ?? [], referenceVecs)
        } catch (err) {
          return {
            value: 0,
            passed: false,
            label: "style-embedding",
            rationale: err instanceof EmbeddingDimensionError ? err.message : "embedding failed",
          }
        }
        const passed = value >= threshold
        return {
          value,
          passed,
          label: "style-embedding",
          rationale: `cosine-to-centroid over ${referenceVecs.length} reference(s), threshold ${threshold}`,
        }
      }),
    ],
  })
}
