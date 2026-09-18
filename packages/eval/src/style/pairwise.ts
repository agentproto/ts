import { z } from "zod"
import { defineTool } from "@agentproto/tool"
import { defineDriver, implementTool, type DriverHandle } from "@agentproto/driver"
import { scoreSchema } from "../score.js"
import type { JudgeFn } from "../judge.js"

/**
 * `eval.style-pairwise` — model-backed A/B scorer: which of `a`/`b` reads
 * closer to `reference` under `criteria`. Reuses the existing {@link JudgeFn}
 * seam from judge.ts (no new judge type) — the driver hands the judge
 * `{reference, a, b}` as `output` and reads back a single verdict whose
 * `value` encodes preference: 1 = `a` wins, 0 = `b` wins, 0.5 = tie.
 *
 * `pairwiseWinRate` below is a SEPARATE pure helper: callers run this tool
 * multiple times (varying which side is presented first, and across
 * multiple judges) and feed the resulting {winner} outcomes to it to get an
 * order-debiased win rate plus inter-judge agreement (Cohen's kappa).
 */

// ---------------------------------------------------------------------------
// eval.style-pairwise — the TOOL contract
// ---------------------------------------------------------------------------

export interface StylePairwiseInput {
  readonly reference: string
  readonly a: string
  readonly b: string
  readonly criteria: string
}

export const stylePairwiseTool = defineTool({
  id: "eval.style-pairwise",
  description:
    "Model-backed scorer: asks an injected judge which of `a`/`b` is closer " +
    "in style to `reference` under `criteria`. value encodes preference " +
    "(1 = a wins, 0 = b wins, 0.5 = tie). The judge lives in the driver (see " +
    "makeStylePairwiseDriver) — this tool contract carries no model call.",
  version: "0.1.0",
  inputSchema: z.object({
    reference: z.string().describe("The reference style text."),
    a: z.string().describe("Candidate A."),
    b: z.string().describe("Candidate B."),
    criteria: z.string().describe("Free-form grading criteria/rubric for the judge."),
  }),
  outputSchema: scoreSchema,
  mutates: [],
  approval: "auto",
  riskLevel: 0,
})

// ---------------------------------------------------------------------------
// makeStylePairwiseDriver — closes over the injected JudgeFn
// ---------------------------------------------------------------------------

function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x))
}

/**
 * Build a DRIVER that implements `eval.style-pairwise` by delegating to
 * `judge` — the same {@link JudgeFn} shape as `eval.llm-judge`, reused rather
 * than threading a bespoke comparison type through this package.
 */
export function makeStylePairwiseDriver(judge: JudgeFn): DriverHandle {
  return defineDriver({
    id: "eval-style-pairwise",
    name: "Eval Style Pairwise (model-backed)",
    description:
      "Model-backed scorer driver: implements eval.style-pairwise by " +
      "awaiting an injected JudgeFn over {reference, a, b} and mapping its " +
      "verdict.value to an a-vs-b preference score.",
    version: "0.1.0",
    kind: "builtin",
    implements: [{ tool: "eval.style-pairwise", version: "0.1.0" }],
    implementations: [
      implementTool(stylePairwiseTool, async ({ input }) => {
        const verdict = await judge({
          output: { reference: input.reference, a: input.a, b: input.b },
          criteria: input.criteria,
          expected: input.reference,
        })
        const value = clamp01(verdict.value)
        const passed = verdict.passed ?? value >= 0.5
        return {
          value,
          passed,
          label: "style-pairwise",
          ...(verdict.rationale ? { rationale: verdict.rationale } : {}),
        }
      }),
    ],
  })
}

// ---------------------------------------------------------------------------
// pairwiseWinRate — pure helper over collected verdicts
// ---------------------------------------------------------------------------

export type PairwiseWinner = "a" | "b" | "tie"

/**
 * One collected pairwise outcome. `order` records which physical position
 * `a` was presented in when this verdict was produced; `winner` is the RAW
 * outcome as reported for that presentation (before un-swapping) — e.g. a
 * judge exhibiting pure position bias always picks the same physical slot,
 * which shows up here as `winner` tracking `order` rather than content.
 * `pairwiseWinRate` un-swaps `winner` back to the logical a/b before
 * aggregating, which is what neutralizes that bias.
 */
export interface PairwiseVerdict {
  /** Judge identity — distinguishes the (at least two) judges being compared. */
  readonly judge: string
  /** Physical presentation order this verdict was collected under. */
  readonly order: "normal" | "swapped"
  /** Raw winner as reported under `order` (not yet un-swapped). */
  readonly winner: PairwiseWinner
}

export interface PairwiseWinRateResult {
  /** Logical a-win rate (ties count as 0.5), after order de-biasing. */
  readonly winRate: number
  /** Cohen's kappa agreement between the two most-represented judges. */
  readonly kappa: number
  /** Number of verdicts folded in. */
  readonly n: number
}

function unswap(winner: PairwiseWinner, order: "normal" | "swapped"): PairwiseWinner {
  if (order === "normal" || winner === "tie") return winner
  return winner === "a" ? "b" : "a"
}

/** Cohen's kappa for two equal-length categorical rating sequences. */
function cohenKappa(r1: readonly PairwiseWinner[], r2: readonly PairwiseWinner[]): number {
  const n = r1.length
  if (n === 0) return 1
  let agree = 0
  const categories: PairwiseWinner[] = ["a", "b", "tie"]
  const counts1 = new Map<PairwiseWinner, number>(categories.map((c) => [c, 0]))
  const counts2 = new Map<PairwiseWinner, number>(categories.map((c) => [c, 0]))
  for (let i = 0; i < n; i++) {
    const x1 = r1[i]!
    const x2 = r2[i]!
    if (x1 === x2) agree++
    counts1.set(x1, (counts1.get(x1) ?? 0) + 1)
    counts2.set(x2, (counts2.get(x2) ?? 0) + 1)
  }
  const po = agree / n
  const pe = categories.reduce((sum, c) => sum + ((counts1.get(c) ?? 0) / n) * ((counts2.get(c) ?? 0) / n), 0)
  if (pe >= 1) return po === 1 ? 1 : 0
  return (po - pe) / (1 - pe)
}

/**
 * Aggregate collected {@link PairwiseVerdict}s into an order-debiased win
 * rate and inter-judge Cohen's kappa. Position bias is neutralized by
 * un-swapping each verdict's `winner` against its `order` before folding it
 * in — a judge that always picks the physically-first option nets out near
 * 0.5 rather than always "a". Kappa is computed between the two judges with
 * the most verdicts, zipped in encounter order.
 */
export function pairwiseWinRate(verdicts: readonly PairwiseVerdict[]): PairwiseWinRateResult {
  const n = verdicts.length
  const normalized = verdicts.map((v) => ({ judge: v.judge, winner: unswap(v.winner, v.order) }))

  const aWins = normalized.reduce((sum, v) => {
    if (v.winner === "a") return sum + 1
    if (v.winner === "tie") return sum + 0.5
    return sum
  }, 0)
  const winRate = n === 0 ? 0 : aWins / n

  const byJudge = new Map<string, PairwiseWinner[]>()
  for (const v of normalized) {
    const arr = byJudge.get(v.judge) ?? []
    arr.push(v.winner)
    byJudge.set(v.judge, arr)
  }
  const judges = [...byJudge.entries()].sort((a, b) => b[1].length - a[1].length)

  let kappa = 1
  if (judges.length >= 2) {
    const [, r1] = judges[0]!
    const [, r2] = judges[1]!
    const m = Math.min(r1.length, r2.length)
    kappa = cohenKappa(r1.slice(0, m), r2.slice(0, m))
  }

  return { winRate, kappa, n }
}
