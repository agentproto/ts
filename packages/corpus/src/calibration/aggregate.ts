/**
 * Multi-reviewer score aggregation.
 *
 * High-stakes corpus entries (those flagged by curator policy as
 * needing N-reviewer review) get scored by multiple reviewers — the
 * single-reviewer path is fine for the bulk of the queue, but the
 * top quality tier deserves redundancy.
 *
 * Aggregation policy:
 *   - **Median** is the default — robust to a single outlier reviewer.
 *   - **Weighted-median** uses reviewer track-record weights so a
 *     well-calibrated reviewer's score counts for more than a fresh /
 *     under-calibrated one.
 *
 * Disagreement detection: when the spread between the highest and
 * lowest review exceeds a threshold, the aggregate carries a
 * `disagreement: true` flag — the curator's queue can route those
 * entries to human adjudication rather than auto-trust the median.
 *
 * Pure — no I/O. Inputs come from the lifecycle workflow; outputs
 * feed the gate evaluator.
 */

export interface ReviewerScore {
  /** AIP-23-style identity. */
  readonly reviewerIdentity: string
  /** 0..5 (matches metadata.corpus.qualityScore convention). */
  readonly score: number
  /**
   * Optional confidence weight from the reviewer's track record
   * (correlation with downstream utility/lift). Defaults to 1.0
   * for unknown reviewers. See `correlation.ts`.
   */
  readonly weight?: number
  readonly at: string
  readonly note?: string
}

export interface AggregateOptions {
  /** Spread threshold above which `disagreement` is flagged. Default: 1.5. */
  readonly disagreementThreshold?: number
  /** When true, use weighted-median; else plain median. */
  readonly weighted?: boolean
}

export interface AggregateResult {
  /** Aggregate qualityScore (0..5). */
  readonly aggregate: number
  /** Highest vs lowest review difference. */
  readonly spread: number
  /** True when spread > disagreementThreshold. */
  readonly disagreement: boolean
  /** Number of reviewers that contributed. */
  readonly sampleSize: number
  /** Per-reviewer breakdown for the curator UI. */
  readonly breakdown: readonly {
    readonly reviewerIdentity: string
    readonly score: number
    readonly weight: number
  }[]
}

const DEFAULT_DISAGREEMENT_THRESHOLD = 1.5

/**
 * Aggregate N reviewer scores into one final score + a disagreement
 * flag. Empty input → aggregate=0, disagreement=false (caller decides
 * whether that's an error).
 */
export function aggregateReviewerScores(
  reviews: readonly ReviewerScore[],
  opts: AggregateOptions = {}
): AggregateResult {
  if (reviews.length === 0) {
    return Object.freeze({
      aggregate: 0,
      spread: 0,
      disagreement: false,
      sampleSize: 0,
      breakdown: Object.freeze([]),
    })
  }
  const threshold = opts.disagreementThreshold ?? DEFAULT_DISAGREEMENT_THRESHOLD
  const weighted = opts.weighted !== false // default true

  const breakdown = reviews.map((r) => ({
    reviewerIdentity: r.reviewerIdentity,
    score: r.score,
    weight: typeof r.weight === "number" && r.weight > 0 ? r.weight : 1,
  }))
  const scores = breakdown.map((b) => b.score)
  const min = Math.min(...scores)
  const max = Math.max(...scores)
  const spread = max - min

  const aggregate = weighted
    ? weightedMedian(breakdown)
    : plainMedian(scores)

  return Object.freeze({
    aggregate,
    spread,
    disagreement: spread > threshold,
    sampleSize: reviews.length,
    breakdown: Object.freeze(breakdown),
  })
}

// ── Helpers ─────────────────────────────────────────────────────────

function plainMedian(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1]! + sorted[mid]!) / 2
  }
  return sorted[mid]!
}

/**
 * Weighted median: order by score, cumulate weights, pick the score
 * at which the cumulative weight first crosses half the total weight.
 * Robust to outliers AND to the well-calibrated reviewers getting
 * more say than the under-calibrated ones.
 */
function weightedMedian(
  items: readonly { score: number; weight: number }[]
): number {
  const sorted = [...items].sort((a, b) => a.score - b.score)
  const totalWeight = sorted.reduce((acc, it) => acc + it.weight, 0)
  if (totalWeight === 0) return plainMedian(items.map((i) => i.score))
  const half = totalWeight / 2
  let acc = 0
  for (let i = 0; i < sorted.length; i++) {
    acc += sorted[i]!.weight
    if (acc >= half) {
      // When acc lands exactly on half + the next item also has
      // identical cumulative weight, the median is the average of the
      // two adjacent scores (matches the symmetric definition).
      if (acc === half && i + 1 < sorted.length) {
        return (sorted[i]!.score + sorted[i + 1]!.score) / 2
      }
      return sorted[i]!.score
    }
  }
  return sorted[sorted.length - 1]!.score
}
