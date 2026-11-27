---
"@agentproto/billing-stripe": minor
"@agentproto/billing": patch
---

`@agentproto/billing-stripe`, call side: checkout, billing portal, refunds, catalog sync and the full provider factory.

- **`createCheckout`**: return URLs checked against `allowedReturnOrigins`, owner keys, offer, quantity, buyer-amount bounds and trial all checked before any call; the price found by lookup key (refused when it drifted from the manifest) or `price_data` for a buyer amount; `agentproto_offer` and every `agentproto_owner_<key>` on the session and on `subscription_data.metadata`; promotion codes only with `discounts: allow`; trial days from `subscription.trial`.
- **`createPortalSession`**: `billingPortal.sessions.create` with a checked return URL and the payer's customer id.
- **`refund`**: `refunds.create` with `ref` as the idempotency key; a movement that is not `stripe:pi_...` is refused without a call; a refusal by Stripe comes back as `{ ok: false, error }` with every credential masked.
- **`syncCatalog`** and the pure **`toStripeCatalog`**: one product per offer under a stable id, prices found by lookup key, a changed price replaced by a new one that takes the key over, never a delete, idempotent writes, `dryRun` read-only, degradations named by offer and field.
- **`check()`** also reads `accounts.retrieveCurrent()` against `expectAccount` for the mode.
- **Capabilities**: `refunds: "partial"`, `checkout`, `portal`, `catalogSync` on; `assertRailCapabilities` accepts a manifest on this rail. Every SET-* contract case runs, none declared unsupported.
- **Options**: `createStripeProvider` now requires `manifest` and `allowedReturnOrigins`, and takes `expectAccount`, `automaticTax` and `rail`. `createProvider` is async: without a `client` it imports the `stripe` peer and builds it at `STRIPE_API_VERSION`, with a clear message when the package is missing.

`@agentproto/billing`: the README points to the Stripe provider package.
