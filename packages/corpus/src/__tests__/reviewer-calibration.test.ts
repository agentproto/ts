/**
 * Reviewer calibration: multi-reviewer aggregation + track-record
 * persistence + Pearson correlation.
 */

import { describe, expect, it } from "vitest"
import {
  aggregateReviewerScores,
  computeReviewerCalibration,
  pearsonCorrelation,
  ReviewerTrackRecord,
} from "../index.js"
import type {
  ReviewerScore,
  TrackRecordEntry,
} from "../index.js"
import { MemoryFs } from "./_helpers/memory-fs.js"

// ── Aggregation ─────────────────────────────────────────────────────

describe("aggregateReviewerScores", () => {
  it("empty input → zero aggregate, no disagreement", () => {
    const r = aggregateReviewerScores([])
    expect(r.aggregate).toBe(0)
    expect(r.disagreement).toBe(false)
    expect(r.sampleSize).toBe(0)
  })

  it("single reviewer → that score is the aggregate", () => {
    const r = aggregateReviewerScores([
      { reviewerIdentity: "ws://operators/a", score: 4.2, at: "t" },
    ])
    expect(r.aggregate).toBe(4.2)
    expect(r.sampleSize).toBe(1)
    expect(r.disagreement).toBe(false)
    expect(r.spread).toBe(0)
  })

  it("three reviewers in agreement → plain median", () => {
    const r = aggregateReviewerScores([
      { reviewerIdentity: "a", score: 4.0, at: "t" },
      { reviewerIdentity: "b", score: 4.1, at: "t" },
      { reviewerIdentity: "c", score: 4.2, at: "t" },
    ])
    expect(r.aggregate).toBe(4.1)
    expect(r.disagreement).toBe(false)
  })

  it("flags disagreement when spread > threshold", () => {
    // 1.0 vs 4.5 spread = 3.5, threshold default 1.5
    const r = aggregateReviewerScores([
      { reviewerIdentity: "a", score: 1.0, at: "t" },
      { reviewerIdentity: "b", score: 4.5, at: "t" },
      { reviewerIdentity: "c", score: 3.0, at: "t" },
    ])
    expect(r.disagreement).toBe(true)
    expect(r.spread).toBe(3.5)
  })

  it("respects custom disagreement threshold", () => {
    const r = aggregateReviewerScores(
      [
        { reviewerIdentity: "a", score: 2.0, at: "t" },
        { reviewerIdentity: "b", score: 3.0, at: "t" },
      ],
      { disagreementThreshold: 0.5 }
    )
    expect(r.disagreement).toBe(true) // 1.0 > 0.5
  })

  it("weighted median tilts toward higher-weight reviewers", () => {
    // Three reviewers: 2.0, 4.0, 4.0 with weights 0.1, 1.0, 1.0.
    // Plain median = 4.0. Weighted median pulls toward 4.0 too
    // since 2.0 has minimal weight. Symmetric proof:
    const r = aggregateReviewerScores([
      { reviewerIdentity: "low", score: 2.0, weight: 0.1, at: "t" },
      { reviewerIdentity: "high1", score: 4.0, weight: 1.0, at: "t" },
      { reviewerIdentity: "high2", score: 4.0, weight: 1.0, at: "t" },
    ])
    expect(r.aggregate).toBe(4.0)
  })

  it("weighted median: well-calibrated reviewer overrides outlier", () => {
    // calibrated reviewer (weight 1.0) says 4.5, two miscalibrated
    // reviewers (weight 0.1) say 1.0 each. Plain median would be
    // 1.0, weighted median should land near the trusted reviewer.
    const r = aggregateReviewerScores([
      { reviewerIdentity: "junk1", score: 1.0, weight: 0.1, at: "t" },
      { reviewerIdentity: "trusted", score: 4.5, weight: 1.0, at: "t" },
      { reviewerIdentity: "junk2", score: 1.0, weight: 0.1, at: "t" },
    ])
    expect(r.aggregate).toBe(4.5)
  })

  it("plain median mode (weighted=false)", () => {
    const r = aggregateReviewerScores(
      [
        { reviewerIdentity: "a", score: 1.0, weight: 0.1, at: "t" },
        { reviewerIdentity: "b", score: 5.0, weight: 1.0, at: "t" },
        { reviewerIdentity: "c", score: 1.0, weight: 0.1, at: "t" },
      ],
      { weighted: false }
    )
    // Plain median ignores weights → 1.0 (middle of [1, 1, 5])
    expect(r.aggregate).toBe(1.0)
  })

  it("breakdown surfaces per-reviewer data for curator UI", () => {
    const r = aggregateReviewerScores([
      { reviewerIdentity: "a", score: 3.0, weight: 0.5, at: "t" },
      { reviewerIdentity: "b", score: 4.0, at: "t" }, // no weight → 1.0 default
    ])
    expect(r.breakdown.length).toBe(2)
    expect(r.breakdown[0]).toEqual({
      reviewerIdentity: "a",
      score: 3.0,
      weight: 0.5,
    })
    expect(r.breakdown[1]?.weight).toBe(1) // default
  })
})

// ── Track record ───────────────────────────────────────────────────

describe("ReviewerTrackRecord", () => {
  it("load on missing file → empty record", async () => {
    const fs = new MemoryFs()
    const r = new ReviewerTrackRecord({ fs, path: "_cal.yaml" })
    expect(await r.load()).toEqual({})
  })

  it("append + load round-trips YAML", async () => {
    const fs = new MemoryFs()
    const r = new ReviewerTrackRecord({ fs, path: "_cal.yaml" })
    await r.append("ws://operators/junior", {
      entrySlug: "foo",
      qualityScore: 4.2,
      observedUtility: 0.7,
      at: "2026-05-22T14:30:00Z",
    })
    await r.append("ws://operators/junior", {
      entrySlug: "bar",
      qualityScore: 3.8,
      observedUtility: 0.5,
      at: "2026-05-23T14:30:00Z",
    })
    const all = await r.load()
    expect(Object.keys(all).length).toBe(1)
    expect(all["ws://operators/junior"]?.length).toBe(2)
  })

  it("window slices by recency", async () => {
    const fs = new MemoryFs()
    const r = new ReviewerTrackRecord({ fs, path: "_cal.yaml" })
    await r.append("ws://operators/r", {
      entrySlug: "ancient",
      qualityScore: 1,
      at: "2024-01-01T00:00:00Z",
    })
    await r.append("ws://operators/r", {
      entrySlug: "recent",
      qualityScore: 4,
      at: "2026-05-01T00:00:00Z",
    })
    const window = await r.window(
      "ws://operators/r",
      90,
      new Date("2026-05-30T00:00:00Z")
    )
    expect(window.length).toBe(1)
    expect(window[0]?.entrySlug).toBe("recent")
  })

  it("listReviewers returns identities present", async () => {
    const fs = new MemoryFs()
    const r = new ReviewerTrackRecord({ fs, path: "_cal.yaml" })
    await r.append("ws://operators/a", {
      entrySlug: "x",
      qualityScore: 4,
      at: "t",
    })
    await r.append("ws://operators/b", {
      entrySlug: "y",
      qualityScore: 4,
      at: "t",
    })
    expect([...(await r.listReviewers())].sort()).toEqual([
      "ws://operators/a",
      "ws://operators/b",
    ])
  })
})

// ── Pearson correlation ───────────────────────────────────────────

describe("pearsonCorrelation", () => {
  it("perfect positive correlation → 1", () => {
    const r = pearsonCorrelation([1, 2, 3, 4, 5], [10, 20, 30, 40, 50])
    expect(r).toBeCloseTo(1, 10)
  })

  it("perfect negative correlation → -1", () => {
    const r = pearsonCorrelation([1, 2, 3, 4, 5], [50, 40, 30, 20, 10])
    expect(r).toBeCloseTo(-1, 10)
  })

  it("zero correlation when output doesn't track input", () => {
    // Symmetric — no linear trend
    const r = pearsonCorrelation([1, 2, 3, 4, 5], [3, 1, 4, 1, 5])
    expect(Math.abs(r)).toBeLessThan(0.5)
  })

  it("NaN when sample < 2", () => {
    expect(Number.isNaN(pearsonCorrelation([], []))).toBe(true)
    expect(Number.isNaN(pearsonCorrelation([1], [2]))).toBe(true)
  })

  it("NaN when zero variance", () => {
    expect(Number.isNaN(pearsonCorrelation([1, 1, 1], [2, 3, 4]))).toBe(true)
    expect(Number.isNaN(pearsonCorrelation([1, 2, 3], [5, 5, 5]))).toBe(true)
  })

  it("throws on length mismatch", () => {
    expect(() => pearsonCorrelation([1, 2], [1, 2, 3])).toThrow(/length mismatch/)
  })
})

// ── Reviewer calibration ──────────────────────────────────────────

describe("computeReviewerCalibration", () => {
  function entries(
    pairs: Array<[score: number, utility: number]>
  ): TrackRecordEntry[] {
    return pairs.map(([qualityScore, observedUtility], i) => ({
      entrySlug: `slug-${i}`,
      qualityScore,
      observedUtility,
      at: `2026-05-${(i + 1).toString().padStart(2, "0")}T00:00:00Z`,
    }))
  }

  it("calibrated reviewer (strong positive corr) → isCalibrated=true, weight≥0.7", () => {
    // qualityScore perfectly predicts utility
    const e = entries([
      [1, 0.1], [2, 0.3], [3, 0.5], [4, 0.7], [5, 0.9],
      [1, 0.1], [2, 0.3], [3, 0.5], [4, 0.7], [5, 0.9],
    ])
    const c = computeReviewerCalibration("ws://operators/strong", e)
    expect(c.isCalibrated).toBe(true)
    expect(c.suggestedWeight).toBeGreaterThanOrEqual(0.7)
    expect(c.status).toBe("calibrated")
  })

  it("miscalibrated reviewer (weak corr) → isCalibrated=false, weight<0.7", () => {
    // No linear trend
    const e = entries([
      [4.2, 0.1], [4.1, 0.9], [4.3, 0.5], [4.2, 0.2], [4.0, 0.7],
      [4.4, 0.3], [4.1, 0.6], [4.2, 0.4], [4.3, 0.8], [4.0, 0.5],
    ])
    const c = computeReviewerCalibration("ws://operators/weak", e)
    expect(c.isCalibrated).toBe(false)
    expect(c.suggestedWeight).toBeLessThan(0.7)
    expect(c.status).toBe("miscalibrated")
  })

  it("insufficient-sample → neutral weight (1.0), no penalty", () => {
    const e = entries([[3, 0.5], [4, 0.7]])
    const c = computeReviewerCalibration("ws://operators/new", e)
    expect(c.status).toBe("insufficient-sample")
    expect(c.suggestedWeight).toBe(1)
  })

  it("no-variance (one-note scorer) → de-weighted but not zero", () => {
    // Reviewer always assigns 4.0 → zero variance → no correlation possible
    const e = entries([
      [4, 0.1], [4, 0.3], [4, 0.5], [4, 0.7], [4, 0.9],
      [4, 0.1], [4, 0.3], [4, 0.5], [4, 0.7], [4, 0.9],
    ])
    const c = computeReviewerCalibration("ws://operators/flatscore", e)
    expect(c.status).toBe("no-variance")
    expect(c.suggestedWeight).toBe(0.3)
  })

  it("respects custom thresholds", () => {
    // Moderate correlation
    const e = entries([
      [1, 0.5], [2, 0.4], [3, 0.6], [4, 0.7], [5, 0.6],
      [1, 0.5], [2, 0.4], [3, 0.6], [4, 0.7], [5, 0.6],
    ])
    // Default threshold (0.4) → likely calibrated
    const cDefault = computeReviewerCalibration("r", e)
    // Strict threshold (0.9) → miscalibrated
    const cStrict = computeReviewerCalibration("r", e, {
      calibratedThreshold: 0.9,
    })
    expect(cDefault.isCalibrated).toBe(true)
    expect(cStrict.isCalibrated).toBe(false)
  })

  it("negative correlation reviewer (inverse predictor) → near-zero weight", () => {
    const e = entries([
      [1, 0.9], [2, 0.7], [3, 0.5], [4, 0.3], [5, 0.1],
      [1, 0.9], [2, 0.7], [3, 0.5], [4, 0.3], [5, 0.1],
    ])
    const c = computeReviewerCalibration("ws://operators/inverse", e)
    expect(c.isCalibrated).toBe(false)
    expect(c.correlationUtility).toBeLessThan(-0.9)
    expect(c.suggestedWeight).toBeLessThan(0.1)
  })
})

// ── Integration: calibration → aggregator ─────────────────────────

describe("Calibration feeds weighted aggregation", () => {
  it("trusted reviewer's calibration weight overrides junk reviewers", () => {
    // Simulate: well-calibrated reviewer alone says 4.5; two
    // miscalibrated reviewers say 1.0. The weighted median should
    // land at 4.5 thanks to the calibration weights.
    const reviews: ReviewerScore[] = [
      {
        reviewerIdentity: "ws://operators/strong",
        score: 4.5,
        weight: 1.0,
        at: "t",
      },
      {
        reviewerIdentity: "ws://operators/weak1",
        score: 1.0,
        weight: 0.1,
        at: "t",
      },
      {
        reviewerIdentity: "ws://operators/weak2",
        score: 1.0,
        weight: 0.1,
        at: "t",
      },
    ]
    const r = aggregateReviewerScores(reviews)
    expect(r.aggregate).toBe(4.5)
    expect(r.disagreement).toBe(true) // spread 3.5 > 1.5
  })
})
