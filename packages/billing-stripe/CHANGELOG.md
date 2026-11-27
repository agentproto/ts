# @agentproto/billing-stripe

## 0.1.0

### Minor Changes

- 58713bc: `@agentproto/billing-stripe`, call side: checkout, billing portal, refunds, catalog sync and the full provider factory.

  - **`createCheckout`**: return URLs checked against `allowedReturnOrigins`, owner keys, offer, quantity, buyer-amount bounds and trial all checked before any call; the price found by lookup key (refused when it drifted from the manifest) or `price_data` for a buyer amount; `agentproto_offer` and every `agentproto_owner_<key>` on the session and on `subscription_data.metadata`; promotion codes only with `discounts: allow`; trial days from `subscription.trial`.
  - **`createPortalSession`**: `billingPortal.sessions.create` with a checked return URL and the payer's customer id.
  - **`refund`**: `refunds.create` with `ref` as the idempotency key; a movement that is not `stripe:pi_...` is refused without a call; a refusal by Stripe comes back as `{ ok: false, error }` with every credential masked.
  - **`syncCatalog`** and the pure **`toStripeCatalog`**: one product per offer under a stable id, prices found by lookup key, a changed price replaced by a new one that takes the key over, never a delete, idempotent writes, `dryRun` read-only, degradations named by offer and field.
  - **`check()`** also reads `accounts.retrieveCurrent()` against `expectAccount` for the mode.
  - **Capabilities**: `refunds: "partial"`, `checkout`, `portal`, `catalogSync` on; `assertRailCapabilities` accepts a manifest on this rail. Every SET-* contract case runs, none declared unsupported.
  - **Options**: `createStripeProvider` now requires `manifest` and `allowedReturnOrigins`, and takes `expectAccount`, `automaticTax` and `rail`. `createProvider` is async: without a `client` it imports the `stripe` peer and builds it at `STRIPE_API_VERSION`, with a clear message when the package is missing.

  `@agentproto/billing`: the README points to the Stripe provider package.

- 57eb5e3: New package: the Stripe settlement provider of `@agentproto/billing`, webhook side.

  - **Signature** verified with `node:crypto` (`t=`, every `v1`, constant time, 300 s tolerance); `STRIPE_API_VERSION` pinned to the installed SDK's version, an event of another version throws.
  - **Mode guard**: `check()` refuses a key of the other mode; an event whose `livemode` disagrees throws.
  - **Money facts**, one source event per payment: paid checkouts, subscription invoices (payment read with `invoicePayments.list`; an invoice not paid by exactly one payment intent becomes one `unsupported` fact, listed as owed), refunds from `refund.*` only, disputes by one rule on their status, `renewal_failed` and `subscription_ended`. Payments outside `agentproto_offer` / `offerNamespace` give no fact. `onUnhandled` is required.
  - **Capabilities** honest for this version: no refund, checkout, portal, catalog sync nor off-session charge yet (`charge`/`pay` answer `unsupported`).
  - The SET-* contract cases run against it; fixtures are built by hand from Stripe's public reference, not recorded.

### Patch Changes

- Updated dependencies [8813d9e]
- Updated dependencies [bf015f6]
- Updated dependencies [bc39e63]
- Updated dependencies [912935b]
- Updated dependencies [58713bc]
- Updated dependencies [243e055]
- Updated dependencies [495ce4b]
  - @agentproto/billing@0.2.0
