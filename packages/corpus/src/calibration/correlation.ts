/**
 * Calibration — correlate a reviewer's qualityScore against the
 * downstream retrieval-quality outcomes (utility + lift). Reviewers
 * whose scores don't predict outcomes are miscalibrated; their
 * weight drops in the multi-reviewer aggregator until they re-train.
 *
 * Math: Pearson correlation coefficient on two parallel arrays.
 * Returns NaN-safe r in [-1, 1]. Threshold for "calibrated" is host
 * policy; the helper just reports.
 *
 * Pure — no I/O. Inputs come from `ReviewerTrackRecord.window`,
 * outputs feed the calibration routine + multi-reviewer aggregator.
 */

import type { TrackRecordEntry } from "./track-record.js"

export interface ReviewerCalibration {
  readonly reviewerIdentity: string
  readonly sampleSize: number
  /**
   * Pearson r in [-1, 1]. Higher = reviewer's qualityScore predicts
   * downstream outcomes better. Negative = reviewer is inversely
   * correlated (worse than random). NaN when sampleSize < 2 or all
   * scores are identical (no variance).
   */
  readonly correlationUtility: number
  readonly correlationLift: number
  /** Whether this reviewer meets the calibrated threshold. */
  readonly isCalibrated: boolean
  /** Suggested weight for the multi-reviewer aggregator (0..1). */
  readonly suggestedWeight: number
  /** Reason flag — useful for curator UI tooltips. */
  readonly status:
    | "calibrated"
    | "miscalibrated"
    | "insufficient-sample"
    | "no-variance"
}

export interface CalibrationOptions {
  /** Minimum sample size to compute calibration. Defaults to 10. */
  readonly minSampleSize?: number
  /** Pearson r threshold above which a reviewer is "calibrated". Defaults to 0.4. */
  readonly calibratedThreshold?: number
}

const DEFAULT_MIN_SAMPLE = 10
const DEFAULT_CALIBRATED_THRESHOLD = 0.4

/**
 * Pearson correlation coefficient on two parallel numeric arrays.
 *
 *   r = cov(X, Y) / (σ_X · σ_Y)
 *
 * Returns NaN when:
 *   - either array is < 2 elements
 *   - either array has zero variance (all values identical)
 *
 * NaN is the explicit "I can't compute this" signal — callers
 * decide whether NaN means "default to neutral weight" or "flag for
 * human review".
 */
export function pearsonCorrelation(
  xs: readonly number[],
  ys: readonly number[]
): number {
  if (xs.length !== ys.length) {
    throw new Error(
      `pearsonCorrelation: array length mismatch (xs=${xs.length}, ys=${ys.length})`
    )
  }
  const n = xs.length
  if (n < 2) return Number.NaN

  let sumX = 0
  let sumY = 0
  for (let i = 0; i < n; i++) {
    sumX += xs[i]!
    sumY += ys[i]!
  }
  const meanX = sumX / n
  const meanY = sumY / n

  let cov = 0
  let varX = 0
  let varY = 0
  for (let i = 0; i < n; i++) {
    const dx = xs[i]! - meanX
    const dy = ys[i]! - meanY
    cov += dx * dy
    varX += dx * dx
    varY += dy * dy
  }
  if (varX === 0 || varY === 0) return Number.NaN
  return cov / Math.sqrt(varX * varY)
}

/**
 * Compute a single reviewer's calibration from their track-record
 * window. Returns a ReviewerCalibration summary.
 *
 * Strategy: average the utility-correlation and lift-correlation
 * (when both are available). If only one outcome was recorded
 * across the window (rare), use that one alone.
 */
export function computeReviewerCalibration(
  reviewerIdentity: string,
  entries: readonly TrackRecordEntry[],
  opts: CalibrationOptions = {}
): ReviewerCalibration {
  const minSample = opts.minSampleSize ?? DEFAULT_MIN_SAMPLE
  const threshold = opts.calibratedThreshold ?? DEFAULT_CALIBRATED_THRESHOLD

  const utilityRows = entries.filter(
    (e) => typeof e.observedUtility === "number"
  )
  const liftRows = entries.filter((e) => typeof e.observedLift === "number")

  if (
    Math.max(utilityRows.length, liftRows.length) < minSample
  ) {
    return Object.freeze({
      reviewerIdentity,
      sampleSize: Math.max(utilityRows.length, liftRows.length),
      correlationUtility: Number.NaN,
      correlationLift: Number.NaN,
      isCalibrated: false,
      suggestedWeight: 1, // neutral — no penalty for insufficient data
      status: "insufficient-sample" as const,
    })
  }

  const corrUtil =
    utilityRows.length >= minSample
      ? pearsonCorrelation(
          utilityRows.map((e) => e.qualityScore),
          utilityRows.map((e) => e.observedUtility!)
        )
      : Number.NaN
  const corrLift =
    liftRows.length >= minSample
      ? pearsonCorrelation(
          liftRows.map((e) => e.qualityScore),
          liftRows.map((e) => e.observedLift!)
        )
      : Number.NaN

  // Compose a single calibration signal: average of available
  // correlations. NaN handling: if both are NaN, the reviewer's
  // scores have no variance in the window (one-note scoring), so
  // flag and de-weight.
  const available = [corrUtil, corrLift].filter((x) => !Number.isNaN(x))
  if (available.length === 0) {
    return Object.freeze({
      reviewerIdentity,
      sampleSize: entries.length,
      correlationUtility: corrUtil,
      correlationLift: corrLift,
      isCalibrated: false,
      suggestedWeight: 0.3, // de-weight but not zero
      status: "no-variance" as const,
    })
  }
  const composite = available.reduce((a, b) => a + b, 0) / available.length

  // Weight derivation: linearly map [threshold, 1] → [0.7, 1.0] for
  // calibrated, [-1, threshold] → [0, 0.7] for miscalibrated.
  // Negative correlation is worst-case = weight 0.
  let weight: number
  let isCalibrated: boolean
  if (composite >= threshold) {
    isCalibrated = true
    weight = 0.7 + 0.3 * ((composite - threshold) / (1 - threshold))
  } else {
    isCalibrated = false
    weight = Math.max(
      0,
      0.7 * ((composite + 1) / (threshold + 1))
    )
  }

  return Object.freeze({
    reviewerIdentity,
    sampleSize: entries.length,
    correlationUtility: corrUtil,
    correlationLift: corrLift,
    isCalibrated,
    suggestedWeight: Math.max(0, Math.min(1, weight)),
    status: isCalibrated ? "calibrated" : "miscalibrated",
  })
}
