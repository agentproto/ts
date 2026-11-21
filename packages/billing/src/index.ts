/**
 * @agentproto/billing: AIP-BILLING reference implementation.
 *
 * Spec: https://agentproto.sh/docs/aip-74 (a draft; the schema is not frozen).
 *
 *   BILLING.md -> `parseBillingManifest` -> `defineBillingManifest` -> handle
 *   rail event -> `SettlementProvider.verifyWebhook` -> `handleRailFact` -> AIP-49 journal
 */

export const SPEC_NAME = "billing/v1" as const
export const SPEC_VERSION = "0.4.0" as const

export { defineBillingManifest, manifestProblems, normalizeManifest, deriveManifest } from "./define-billing-manifest.js"
export type { BillingHandle, BillingDerived, DerivedConversion, DefineBillingManifestOptions } from "./define-billing-manifest.js"
export { billingFrontmatterSchema, type BillingFrontmatter } from "./schema.js"
export type { BillingDefinition, Offer, Grant, Conversion } from "./types.js"
export { entryRatio } from "./rate.js"
export { convertMinor, addDuration, addMonthsUtc, normalizeCurrency, normalizeRef, fiatDeclaration, fiatDecimals } from "./model.js"

export type { CauseEvent, PeriodRecord, PeriodStatus, AccessRecord, BillingStateStore, BillingDeps } from "./ports.js"
export type { SettlementProvider, PaymentFact, RefundFact, DisputeFact, RailFact, WebhookRequest } from "./settlement.js"
export { defaultRailEnv } from "./settlement.js"

export { applyPayment, planPayment, checkPayment, accountIdFor, bonusPercent, traceOf, listOwed } from "./payment.js"
export type { PaymentOutcome, CheckResult, OwedEntry } from "./payment.js"
export { applyRefund, applyDispute, planReclaim } from "./reclaim.js"
export type { Minted } from "./reclaim.js"
export { includeDrops, dueDrops, runDueIncludes, failRenewal, sweepGrace, closePeriod, activeFeatures } from "./periods.js"
export { applyGrant, grantKey, periodKey, eligible as grantEligible } from "./grants.js"
export type { GrantContext, AmountStrategy } from "./grants.js"
export { resolvePayer, canPay } from "./payer.js"
export type { AccountNode, AccountDirectory, PayerResolution, PayerStrategy } from "./payer.js"
export { applyTransfer } from "./transfers.js"
export type { TransferRequest } from "./transfers.js"
export { handleRailFact, handleWebhook } from "./webhook.js"
export type { FactOutcome } from "./webhook.js"
export { railEnvNames, missingRailEnv, assertRailEnv, railMode, assertKeyMatchesMode } from "./rails.js"
export type { RailEnvNames, RailMode } from "./rails.js"
export { BILLING_CATALOG, makeBillingRegistry, toBillingHandle } from "./registry.js"
export type { BillingProviderInfo, BillingRegistry, BillingRegistryOptions } from "./registry.js"
export { offerToProduct } from "./product.js"
