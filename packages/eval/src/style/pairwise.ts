import { z } from "zod"
import { defineTool } from "@agentproto/tool"
import { defineDriver, implementTool, type DriverHandle } from "@agentproto/driver"
import { scoreSchema } from "../score.js"
import type { JudgeFn } from "../judge.js"
import { parseVerdict } from "./verdict.js"

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
        const raw = await judge({
          output: { reference: input.reference, a: input.a, b: input.b },
          criteria: input.criteria,
          expected: input.reference,
        })
        const verdict = parseVerdict(raw)
        if (!verdict) {
          return {
            value: 0,
            passed: false,
            label: "style-pairwise",
            rationale: "judge returned a malformed verdict",
          }
        }
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
  /** Identifies which item this verdict scored — required so verdicts from different items are never zipped together. */
  readonly item: string
  /** Judge identity — distinguishes the (at least two) judges being compared. */
  readonly judge: string
  /** Physical presentation order this verdict was collected under. */
  readonly order: "normal" | "swapped"
  /** Raw winner as reported under `order` (not yet un-swapped). */
  readonly winner: PairwiseWinner
}

export interface PairwiseWinRateResult {
  /** Logical a-win rate (ties count as 0.5), after order de-biasing. Averages the normal-order and swapped-order rates when both are present. */
  readonly winRate: number
  /**
   * Cohen's kappa agreement between the two most-represented judges, computed
   * over items both judges rated. `null` when there are fewer than two
   * judges, or fewer than two items in common — a `null` here means the
   * agreement gate has no evidence and any threshold check against it (e.g.
   * "kappa >= 0.4") must be treated as a FAILURE, not skipped.
   */
  readonly kappa: number | null
  /** Number of verdicts folded in. */
  readonly n: number
  /** Number of verdicts collected under `order: "normal"`. */
  readonly nNormal: number
  /** Number of verdicts collected under `order: "swapped"`. */
  readonly nSwapped: number
  /** `false` when one of the two presentation orders has zero verdicts — `winRate` then reflects only the order that is present, and is not order-debiased. */
  readonly balanced: boolean
}

function unswap(winner: PairwiseWinner, order: "normal" | "swapped"): PairwiseWinner {
  if (order === "normal" || winner === "tie") return winner
  return winner === "a" ? "b" : "a"
}

function aWinScore(winner: PairwiseWinner): number {
  if (winner === "a") return 1
  if (winner === "tie") return 0.5
  return 0
}

/** Cohen's kappa for two equal-length categorical rating sequences. Callers must ensure `r1.length >= 2`. */
function cohenKappa(r1: readonly PairwiseWinner[], r2: readonly PairwiseWinner[]): number {
  const n = r1.length
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
 * rate and inter-judge Cohen's kappa.
 *
 * Win rate: each verdict is un-swapped against its `order` (neutralizing
 * position bias), then the normal-order rate and swapped-order rate are
 * averaged — not a flat average over all verdicts — so a judge that always
 * picks the physically-first slot nets out near 0.5 even if one order was
 * sampled more than the other. When only one order was collected at all,
 * `balanced` is `false` and `winRate` falls back to that order's rate alone.
 *
 * Kappa: verdicts are joined by `item` — for each of the two
 * most-represented judges, at most one (first-seen, un-swapped) winner is
 * kept per item, so a normal+swapped pair on the same item is one
 * observation, not two. Kappa is then computed over the items both judges
 * rated; see {@link PairwiseWinRateResult.kappa} for the `null` cases.
 */
export function pairwiseWinRate(verdicts: readonly PairwiseVerdict[]): PairwiseWinRateResult {
  const n = verdicts.length
  const normalized = verdicts.map((v) => ({ ...v, winner: unswap(v.winner, v.order) }))

  const normalGroup = normalized.filter((v) => v.order === "normal")
  const swappedGroup = normalized.filter((v) => v.order === "swapped")
  const nNormal = normalGroup.length
  const nSwapped = swappedGroup.length
  const rateNormal = nNormal === 0 ? null : normalGroup.reduce((sum, v) => sum + aWinScore(v.winner), 0) / nNormal
  const rateSwapped =
    nSwapped === 0 ? null : swappedGroup.reduce((sum, v) => sum + aWinScore(v.winner), 0) / nSwapped
  const balanced = nNormal > 0 && nSwapped > 0
  const winRate = rateNormal !== null && rateSwapped !== null ? (rateNormal + rateSwapped) / 2 : (rateNormal ?? rateSwapped ?? 0)

  const byJudge = new Map<string, Map<string, PairwiseWinner>>()
  for (const v of normalized) {
    let items = byJudge.get(v.judge)
    if (!items) {
      items = new Map()
      byJudge.set(v.judge, items)
    }
    if (!items.has(v.item)) items.set(v.item, v.winner)
  }
  const judges = [...byJudge.entries()].sort((a, b) => b[1].size - a[1].size)

  let kappa: number | null = null
  if (judges.length >= 2) {
    const [, items1] = judges[0]!
    const [, items2] = judges[1]!
    const commonItems = [...items1.keys()].filter((item) => items2.has(item)).sort()
    if (commonItems.length >= 2) {
      const r1 = commonItems.map((item) => items1.get(item)!)
      const r2 = commonItems.map((item) => items2.get(item)!)
      kappa = cohenKappa(r1, r2)
    }
  }

  return { winRate, kappa, n, nNormal, nSwapped, balanced }
}
