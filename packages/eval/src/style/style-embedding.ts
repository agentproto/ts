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

function centroid(vectors: readonly (readonly number[])[]): number[] {
  const dims = vectors[0]?.length ?? 0
  const sum = new Array(dims).fill(0) as number[]
  for (const v of vectors) {
    for (let i = 0; i < dims; i++) sum[i] = (sum[i] ?? 0) + (v[i] ?? 0)
  }
  return sum.map((x) => x / vectors.length)
}

/**
 * Pure helper: cosine similarity between `candidate` and the centroid of
 * `references`, mapped from the raw [-1, 1] cosine range into [0, 1] (so it
 * can be used directly as a {@link Score.value}). A candidate equal to the
 * centroid returns exactly 1.
 */
export function cosineToCentroid(candidate: readonly number[], references: readonly (readonly number[])[]): number {
  if (references.length === 0) return 0
  const c = centroid(references)
  const cn = norm(c)
  const vn = norm(candidate)
  if (cn === 0 || vn === 0) return 0
  const cosine = dot(candidate, c) / (vn * cn)
  return Math.min(1, Math.max(0, (cosine + 1) / 2))
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
    "to the references' centroid, mapped to [0, 1]. The embedding call " +
    "lives in the driver (see makeStyleEmbeddingDriver) — this tool " +
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
        const value = cosineToCentroid(candidateVec ?? [], referenceVecs)
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
