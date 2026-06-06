/**
 * RatePort — the universal rate oracle.
 *
 * Resolves the destination-major-per-source-major rate for ANY value crossing:
 * credit↔USD peg, points→credit redemption, EUR→credit entry forex, SOL→USD.
 * One port for every convert edge — `convert` is the only operation that reads
 * it, and `verifyNoArbitrage` uses it to prove no cycle yields a gain.
 */

import type { AssetRef } from "../asset.js"

export interface RatePort {
  /**
   * Units of `to` (major) per one unit of `from` (major), at time `at`.
   * Must be > 0 and finite for a legal edge.
   */
  rate(from: AssetRef, to: AssetRef, at: Date): Promise<number>
}
