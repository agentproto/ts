/**
 * @agentproto/billing-stripe: the Stripe settlement provider of
 * `@agentproto/billing` (AIP-74): webhooks and money facts, checkout, billing
 * portal, refunds, catalog sync. See the README for what it covers.
 */
export { STRIPE_API_VERSION } from "./api-version.js"
export {
  refId,
  type StripeCheckoutSessionCreateParamsLike,
  type StripeEventLike,
  type StripeInvoicePaymentLike,
  type StripeLike,
  type StripeListLike,
  type StripePriceCreateParamsLike,
  type StripePriceLike,
  type StripeProductCreateParamsLike,
  type StripeProductLike,
  type StripeRef,
  type StripeRequestOptionsLike,
} from "./client.js"
export {
  PRODUCT_TAG_KEY,
  applyStripeCatalog,
  priceMatches,
  readStripeCatalog,
  stripeRailOf,
  toStripeCatalog,
  trialDaysOf,
  type StripeCatalog,
  type StripeCatalogPrice,
  type StripeCatalogProduct,
  type StripeOfferProjection,
  type StripeTaxBehavior,
  type ToStripeCatalogOptions,
} from "./catalog.js"
export { checkoutMetadata, safeStripeError } from "./calls.js"
export { DEFAULT_TOLERANCE_SEC, StripeSignatureError, signatureHeader, stripeSignatureHeader, verifyStripeSignature } from "./signature.js"
export { HANDLED_EVENT_TYPES, OFFER_KEY, OWNER_KEY_PREFIX, eventToFact, type TranslateContext } from "./translate.js"
export {
  STRIPE_CAPABILITIES,
  STRIPE_ENV,
  STRIPE_RAIL,
  StripeEventError,
  createProvider,
  createStripeProvider,
  loadStripeSdk,
  stripeKeyMode,
  type OnUnhandled,
  type StripeProviderConfig,
  type StripeProviderOptions,
  type StripeRegistryOptions,
} from "./provider.js"
