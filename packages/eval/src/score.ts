import { z } from "zod"

/**
 * The shared output shape every scorer produces.
 *
 * A scorer is an AIP-14 TOOL whose `outputSchema` is exactly this — there is
 * no separate "scorer port". Reusing `Score` as the tool output means the
 * registry, retries, and `toMastraTool` / `toAiSdkTool` projections all apply
 * to scorers for free, identical to any other builtin tool.
 */
export const scoreSchema = z.object({
  /** Normalized score in [0, 1]. */
  value: z.number().min(0).max(1),
  /** Whether the score clears the scorer's own threshold. */
  passed: z.boolean(),
  /** Scorer id, e.g. "exact-match". */
  label: z.string(),
  /** Human-readable explanation of the outcome. */
  rationale: z.string().optional(),
})

export type Score = z.infer<typeof scoreSchema>
