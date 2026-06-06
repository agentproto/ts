/**
 * @agentproto/wallet — AIP-49 principal-owned multi-asset wallet primitive.
 *
 * `asset` (ERC-20 declaration) ⊃ `partition` (ERC-1410 tranche) ⊃ `lot`.
 * Event-sourced journal (`fold`), restriction lattice (`meet`, no laundering),
 * intra-asset `coalesce` vs inter-asset `convert` (no-arbitrage), and an
 * `authorize` policy engine with lineage-min delegation. Pure: every side effect
 * goes through an injected port (see `@agentproto/wallet/ports`).
 *
 * Spec: https://agentproto.sh/docs/wallet
 */

export const SPEC_NAME = "agentwallet/v1" as const
export const SPEC_VERSION = "0.1.0-alpha" as const

// Asset — ERC-20-style declaration + rule set
export type {
  AssetRef,
  AssetStandard,
  ChainRef,
  SettlementNetwork,
  Custody,
  PegSpec,
  ConvertEdge,
  TransferScope,
  AssetRuleSet,
  AssetDeclaration,
} from "./asset.js"
export {
  assetSpendsCategory,
  convertEdgeTo,
  minorUnitScale,
} from "./asset.js"
export { defineAsset } from "./define-asset.js"
export { AssetRegistry } from "./registry.js"
export { assetDeclarationSchema, type AssetDeclarationInput } from "./schema.js"

// Partition — ERC-1410 tranche within an asset
export type { PartitionId, PartitionSpec } from "./partition.js"
export { partitionId, assetOfPartition } from "./partition.js"

// Restriction lattice — the LAW layer
export type { RestrictionTag, Restriction, LatticeCheckResult } from "./restriction-lattice.js"
export {
  UNRESTRICTED,
  canonical,
  meet,
  lessRestrictedOrEqual,
  equalRestriction,
  restrictionWeight,
  verifyLattice,
} from "./restriction-lattice.js"

// Substrate — journal + lot projection
export type {
  Intent,
  EventKind,
  WalletEvent,
  LotStatus,
  Lot,
} from "./fold.js"
export { fold, spendableBalance, balanceByAsset } from "./fold.js"

// Coalescing — intra-asset spend routing
export type { SpendRequest, LotDraw, SpendPlan } from "./coalescing.js"
export { selectLotsForSpend } from "./coalescing.js"

// Convert — inter-asset edge + no-arbitrage
export type {
  ConvertDelta,
  RateResolver,
  NoArbitrageResult,
} from "./convert.js"
export { planConvert, verifyNoArbitrage } from "./convert.js"

// Authorize — policy engine + delegation
export type {
  OperatingAllowance,
  DiscretionaryAllowance,
  AllowanceEnvelope,
  AuthorizeRequest,
  AuthzReason,
  AuthorizeDecision,
} from "./authorize.js"
export { authorize, minEnvelope } from "./authorize.js"
