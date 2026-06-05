/**
 * Asset — the unit of value, declared ERC-20-style.
 *
 * An asset is the broadest spine of the wallet (`asset ⊃ partition ⊃ lot`).
 * There is deliberately NO "assetClass" taxonomy above it: the `standard` field
 * inside the declaration is the only discriminator, and it routes to a
 * settlement/valuation adapter polymorphically — never an `if standard === …`.
 *
 * `decimals` carries the smallest-unit precision (2 for credits → centicredits,
 * 6 for USDC, 18 for most ERC-20), which is what kills the ad-hoc ×100 unit-bug
 * class structurally: amounts everywhere are minor units of the asset.
 */

import type { Restriction } from "./restriction-lattice.js"

/** Unique, human-readable key. Convention: `<ORIGIN>_<SYMBOL>` or bare ISO-4217. */
export type AssetRef = string

/** Discriminator picking the settlement/valuation adapter. Not a user taxonomy. */
export type AssetStandard = "internal" | "iso4217" | "erc20" | "spl"

/** Chain id for on-chain standards (erc20/spl). */
export type ChainRef = string

/** Where value of this asset may settle OUT (leave the wallet). */
export type SettlementNetwork =
  | "internal-ledger"
  | "stripe"
  | "pawapay"
  | "x402"
  | "solana"

/** Custody model for on-chain assets. */
export type Custody = "custodial-mirror" | "on-chain-authority"

/** How this asset is valued against a reference asset; resolved by RatePort. */
export interface PegSpec {
  /** Reference asset the peg is denominated against (usually "USD"). */
  vs: AssetRef
  /** Rate source key — `fixed:<ratio>` or an oracle id resolved by RatePort. */
  source: string
}

/** A legal conversion from this asset to another — the ONLY inter-asset edge. */
export interface ConvertEdge {
  /** Destination asset ref. */
  to: AssetRef
  /** Rate basis: fixed multiplier, or an oracle source resolved by RatePort. */
  rate:
    | { kind: "fixed"; ratio: number }
    | { kind: "oracle"; source: string }
  /** Restriction added to the output (accumulates via the lattice meet). */
  addsRestriction?: Restriction
  /** Optional throughput cap (anti-inflation; load-bearing for guild-mint). */
  cap?: { amount: number; windowSec: number }
}

/** Who may move this asset between wallets. */
export type TransferScope = "none" | "internal" | "external"

/** The per-asset rule set — what the asset is allowed to do. */
export interface AssetRuleSet {
  /** May value LEAVE the wallet, via which network? `false` = never settles out. */
  settleOut: SettlementNetwork | false
  /** Spend categories payable. `["*"]` = anything; `[]` = convertible-only (e.g. points). */
  spendableOn: readonly string[]
  /** Legal conversions to other assets. */
  convertEdges: readonly ConvertEdge[]
  /** Transfer scope between wallets. */
  transfer: TransferScope
  /** Custody for on-chain assets (defaults to custodial-mirror). */
  custody?: Custody
}

/** ERC-20-style asset declaration. The registry key is `ref`. */
export interface AssetDeclaration {
  ref: AssetRef
  name: string
  symbol: string
  decimals: number
  standard: AssetStandard
  chain?: ChainRef
  peg?: PegSpec
  ruleSet: AssetRuleSet
}

/** Does this asset (absent a narrowing partition) pay for `category`? */
export function assetSpendsCategory(
  asset: AssetDeclaration,
  category: string,
): boolean {
  const on = asset.ruleSet.spendableOn
  return on.includes("*") || on.includes(category)
}

/** Find the legal convert edge from `asset` to `to`, if any. */
export function convertEdgeTo(
  asset: AssetDeclaration,
  to: AssetRef,
): ConvertEdge | undefined {
  return asset.ruleSet.convertEdges.find(e => e.to === to)
}

/** Minor-unit scale factor for an asset (10 ** decimals). */
export function minorUnitScale(asset: AssetDeclaration): number {
  return 10 ** asset.decimals
}
