/**
 * Coalescing — the spend-routing policy (INTRA-asset only).
 *
 * A spend names an asset + category + amount. Eligibility is structural: a lot
 * qualifies only if its asset matches AND its (partition-narrowed) spendableOn
 * covers the category. So a spend can never drain the wrong partition — and can
 * never touch an asset with no spend edge (e.g. points): the lots simply aren't
 * eligible.
 *
 * Among eligible lots the default order is **restricted-first** (burn the most
 * constrained money before the fungible money, so general credit is preserved
 * for what only general can pay) then **expiring-first** (use soonest-to-expire
 * before it's swept) then oldest. Coalescing NEVER crosses an asset boundary —
 * that is `convert`'s job, and only `convert` may cross a peg.
 */

import type { AssetDeclaration, AssetRef } from "./asset.js"
import { assetSpendsCategory } from "./asset.js"
import type { PartitionId, PartitionSpec } from "./partition.js"
import type { Lot } from "./fold.js"
import { floorOf } from "./fold.js"
import { restrictionWeight } from "./restriction-lattice.js"

export interface SpendRequest {
  asset: AssetRef
  category: string
  amount: number
  now: number
}

export interface LotDraw {
  lotId: string
  amount: number
}

export interface SpendPlan {
  draws: LotDraw[]
  /** Amount that could not be covered by eligible lots (0 = fully funded). */
  shortfall: number
}

/**
 * Available (spendable) amount on a lot right now. For a normal lot this is the
 * unreserved remainder; for a short lot (floor < 0) it's the unused borrowing
 * headroom down to the floor — `Infinity` for an unbounded one. A fully-drawn
 * bounded short lot is `exhausted` ⇒ 0.
 */
function available(lot: Lot, now: number): number {
  if (lot.status === "exhausted") return 0
  if (lot.expiresAt !== undefined && lot.expiresAt <= now) return 0
  return Math.max(0, lot.remaining - lot.reserved - floorOf(lot.floor))
}

/** Categories a lot can pay for: the partition narrows the asset, else the asset's. */
function lotSpendableOn(
  lot: Lot,
  asset: AssetDeclaration,
  partitions: ReadonlyMap<PartitionId, PartitionSpec>,
): readonly string[] {
  return partitions.get(lot.partitionId)?.spendableOn ?? asset.ruleSet.spendableOn
}

function eligible(
  lot: Lot,
  req: SpendRequest,
  asset: AssetDeclaration,
  partitions: ReadonlyMap<PartitionId, PartitionSpec>,
): boolean {
  if (lot.asset !== req.asset) return false
  if (available(lot, req.now) <= 0) return false
  const on = lotSpendableOn(lot, asset, partitions)
  return on.includes("*") || on.includes(req.category)
}

/**
 * Owned-first (short positions last), then restricted-first, then expiring-first
 * (NULLS last), then oldest. Borrowing from a short lot only happens once every
 * real holding is drained — so general credit is spent before going negative.
 */
function compareForSpend(a: Lot, b: Lot): number {
  const sa = floorOf(a.floor) < 0 ? 1 : 0
  const sb = floorOf(b.floor) < 0 ? 1 : 0
  if (sa !== sb) return sa - sb
  const wr = restrictionWeight(b.restriction) - restrictionWeight(a.restriction)
  if (wr !== 0) return wr
  const ea = a.expiresAt ?? Number.POSITIVE_INFINITY
  const eb = b.expiresAt ?? Number.POSITIVE_INFINITY
  if (ea !== eb) return ea - eb
  return a.createdAt - b.createdAt
}

/**
 * Plan which lots to draw for a spend. Pure: returns the draws + any shortfall;
 * the caller emits `burn` events and commits them atomically (serialized per
 * account). The asset declaration + partition map drive eligibility.
 */
export function selectLotsForSpend(
  lots: readonly Lot[],
  req: SpendRequest,
  asset: AssetDeclaration,
  partitions: ReadonlyMap<PartitionId, PartitionSpec>,
): SpendPlan {
  const ordered = lots
    .filter(l => eligible(l, req, asset, partitions))
    .sort(compareForSpend)

  const draws: LotDraw[] = []
  let need = req.amount
  for (const lot of ordered) {
    if (need <= 0) break
    const take = Math.min(need, available(lot, req.now))
    if (take > 0) {
      draws.push({ lotId: lot.id, amount: take })
      need -= take
    }
  }
  return { draws, shortfall: Math.max(0, need) }
}
