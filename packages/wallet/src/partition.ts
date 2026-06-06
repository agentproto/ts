/**
 * Partition — a tranche WITHIN an asset (ERC-1410 partially-fungible token).
 *
 * Lots in the same partition are mutually coalescible (same value, merge
 * freely). A partition narrows its asset along two axes: a `restriction` it
 * carries, and an optional `spendableOn` that NARROWS the asset's categories
 * (e.g. an `image-trial` partition of GUILDE_CREDITS spendable only on `image`).
 *
 * "image-only can't pay for text" is therefore a MISSING capability on the
 * partition, not a runtime `if`.
 */

import type { AssetRef } from "./asset.js"
import type { Restriction } from "./restriction-lattice.js"
import type { PartitionPolicy } from "./partition-policy.js"

/** `<asset>:<tranche>` — e.g. "GUILDE_CREDITS:general", "GUILDE_CREDITS:image-trial". */
export type PartitionId = string

export interface PartitionSpec {
  id: PartitionId
  asset: AssetRef
  /** Restriction every lot in this partition carries. */
  restriction: Restriction
  /** When set, NARROWS the asset's spendableOn for lots in this partition. */
  spendableOn?: readonly string[]
  /** Default lifetime (ms) applied to lots minted into this partition, if any. */
  defaultTtlMs?: number
  /**
   * The partition's lifecycle policy (restriction / expiry / decay / vest /
   * transfer as composable rules). When present it is the source of truth for a
   * lot's effective spendable + eligibility; `restriction` / `spendableOn` /
   * `defaultTtlMs` above are the legacy shorthand for the common rules and stay
   * as a fast path. See `partition-policy.ts`.
   */
  policy?: PartitionPolicy
}

/** Build a conventional partition id from an asset ref and a tranche name. */
export function partitionId(asset: AssetRef, tranche: string): PartitionId {
  return `${asset}:${tranche}`
}

/** The asset ref encoded in a partition id. */
export function assetOfPartition(id: PartitionId): AssetRef {
  const i = id.indexOf(":")
  return i === -1 ? id : id.slice(0, i)
}
