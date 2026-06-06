/**
 * Substrate — the event-sourced journal and its lot projection.
 *
 * The journal is the only source of truth. Lots and balances are a FOLD over
 * events, never a mutated cell. `fold(events)` replays the journal into the lot
 * projection; the reconciliation oracle asserts
 * `fold(events) == stored lots == balance` and stops the rollout on any drift.
 */

import type { AssetRef } from "./asset.js"
import type { PartitionId } from "./partition.js"
import type { Restriction } from "./restriction-lattice.js"
import { UNRESTRICTED } from "./restriction-lattice.js"

/** Spend agency — the safety boundary (passive = cost of existing, active = chosen action). */
export type Intent = "passive" | "active"

/**
 * Journal verbs. `reserve`/`capture`/`release` are the hold two-phase commit;
 * `convert_out`+`convert_in` are the atomic, correlated inter-asset pair.
 */
export type EventKind =
  | "mint"
  | "burn"
  | "reserve"
  | "capture"
  | "release"
  | "convert_in"
  | "convert_out"
  | "transfer"

export interface WalletEvent {
  id: string
  accountId: string
  kind: EventKind
  asset: AssetRef
  partitionId: PartitionId
  restriction: Restriction
  /** Magnitude in the asset's minor units (sign is implied by `kind`). */
  amount: number
  /** Lot this event acts on (mint/convert_in create it; others draw on it). */
  lotId: string
  /** Links convert_out↔convert_in, reserve↔capture/release, settlement↔mint. */
  correlationId?: string
  /** External settlement proof when value crossed the boundary (Stripe pi, tx sig). */
  externalRef?: string
  /** Settlement network the value moved on, if any. */
  settlementNetwork?: string
  intent?: Intent
  /** Lot expiry (epoch ms) — carried on the mint/convert_in event. */
  expiresAt?: number
  /** Peg value at grant time, for provenance. */
  pegAtGrant?: number
  occurredAt: number
}

export type LotStatus = "active" | "exhausted" | "expired"

export interface Lot {
  id: string
  accountId: string
  asset: AssetRef
  partitionId: PartitionId
  restriction: Restriction
  original: number
  remaining: number
  reserved: number
  expiresAt?: number
  pegAtGrant?: number
  sourceEventId: string
  status: LotStatus
  createdAt: number
}

function deriveStatus(lot: Lot, now: number): LotStatus {
  if (lot.remaining <= 0) return "exhausted"
  if (lot.expiresAt !== undefined && lot.expiresAt <= now) return "expired"
  return "active"
}

/**
 * Replay the journal into the lot projection. Events MUST be in occurrence
 * order. `now` is used only to derive lot status (expired vs active); the
 * numeric remaining/reserved are pure folds of the deltas.
 */
export function fold(events: readonly WalletEvent[], now: number): Lot[] {
  const lots = new Map<string, Lot>()

  for (const e of events) {
    switch (e.kind) {
      case "mint":
      case "convert_in": {
        lots.set(e.lotId, {
          id: e.lotId,
          accountId: e.accountId,
          asset: e.asset,
          partitionId: e.partitionId,
          restriction: e.restriction ?? UNRESTRICTED,
          original: e.amount,
          remaining: e.amount,
          reserved: 0,
          expiresAt: e.expiresAt,
          pegAtGrant: e.pegAtGrant,
          sourceEventId: e.id,
          status: "active",
          createdAt: e.occurredAt,
        })
        break
      }
      case "burn":
      case "convert_out": {
        const lot = lots.get(e.lotId)
        if (lot) lot.remaining -= e.amount
        break
      }
      case "transfer": {
        // Within one account's fold, a transfer leg is a burn (out) on the
        // source lot. The matching inbound leg lands as a `mint` on the
        // destination account's journal (separate accountId).
        const lot = lots.get(e.lotId)
        if (lot) lot.remaining -= e.amount
        break
      }
      case "reserve": {
        const lot = lots.get(e.lotId)
        if (lot) lot.reserved += e.amount
        break
      }
      case "capture": {
        // Settle a held portion: the reservation becomes a real burn.
        const lot = lots.get(e.lotId)
        if (lot) {
          lot.remaining -= e.amount
          lot.reserved -= e.amount
        }
        break
      }
      case "release": {
        const lot = lots.get(e.lotId)
        if (lot) lot.reserved -= e.amount
        break
      }
    }
  }

  const out: Lot[] = []
  for (const lot of lots.values()) {
    lot.status = deriveStatus(lot, now)
    out.push(lot)
  }
  return out
}

/** Spendable balance for an asset = Σ(remaining − reserved) over live lots. */
export function spendableBalance(
  lots: readonly Lot[],
  asset: AssetRef,
  now: number,
): number {
  let total = 0
  for (const lot of lots) {
    if (lot.asset !== asset) continue
    if (lot.status === "exhausted") continue
    if (lot.expiresAt !== undefined && lot.expiresAt <= now) continue
    total += lot.remaining - lot.reserved
  }
  return total
}

/** Total balance across all assets (for the reconciliation oracle, per asset). */
export function balanceByAsset(lots: readonly Lot[], now: number): Map<AssetRef, number> {
  const m = new Map<AssetRef, number>()
  for (const lot of lots) {
    if (lot.status === "exhausted") continue
    if (lot.expiresAt !== undefined && lot.expiresAt <= now) continue
    m.set(lot.asset, (m.get(lot.asset) ?? 0) + lot.remaining - lot.reserved)
  }
  return m
}
