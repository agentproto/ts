# @agentproto/billing

## 0.2.0

### Minor Changes

- 8813d9e: **Breaking (pre-1.0 minor).** The payment provider contract a real rail adapter needs: declared capabilities, checkout and portal, typed catalog sync, subscription facts, a provider factory, facts kept until their payment, and the SET-* contract cases.

  - **Capabilities.** `SettlementProvider.capabilities` (`SettlementCapabilities`) is required. `assertRailCapabilities(manifest, providers)` refuses at start-up a manifest that sells an offer its rail cannot serve (subscriptions, trials, buyer amount, discounts, a refund path or a delegation through `moneyFactsFrom`), naming the offer, the rail and the flag. The registry listing (`BillingProviderInfo`) carries the capabilities.
  - **Checkout and portal.** Optional `createCheckout(req)` with four outcomes (`redirect`, `charged`, `invoice_sent`, `no_payment`), none of which writes, and `createPortalSession(req)`. Requests may name the `payer` as the rail knows them. `assertReturnUrl(url, allowedOrigins)` is the shared allow list of return origins, checked before any call.
  - **Catalog.** `syncCatalog(manifest, { dryRun })` takes the whole manifest and returns a `CatalogSyncReport` (`created`, `updated`, `unchanged`, `degradations`).
  - **Subscription facts.** `RenewalFailedFact` (`renewal_failed`, to `failRenewal`) and `SubscriptionEndedFact` (`subscription_ended`, to the new `endSubscription`: the open period closes with `closedReason` `canceled` or `unpaid`, the includes given stay) join `RailFact`; `handleRailFact` dispatches them, `no_period` when there is no open period.
  - **Unsupported payments.** `PaymentFact.unsupported` names why the rail cannot tie a payment to one offer and one payer: the core refuses it, the money is listed as owed, no credit is given.
  - **Facts before their payment.** `BillingStateStore` gains two optional methods, `deferFact` and `takeDeferred`. With them, a refund, a refund reversal or a dispute received before its payment is kept (`deferred`) and applied, in date order, right after the payment is applied through `handleRailFact`. `InMemoryBillingState` implements them.
  - **Disputes out of order.** `opened` and `won` always write a marker: a `won` before its `opened`, or an `opened` with nothing to freeze seen again later, no longer freezes credits.
  - **Registry.** A package may export `createProvider(ctx)` (`env`, `options` from `BillingRegistryOptions.providerOptions`, lazy `providers(slug)` with a cycle guard). `SettlementProvider.check()`, when present, is what the registry's `check` answers.
  - **Contract cases.** `settlementProviderContractCases` in `./contract-tests`: SET-1 to SET-3, SET-5 to SET-13, SET-21, SET-22, driven by a factory of signed requests in the provider's own vocabulary. A missing scenario fails unless declared `unsupported` with its capability off.
  - `FakeSettlementProvider` implements all of it, signs its webhooks with an HMAC, keeps its secrets in private fields, and gives its `events()` factory.

  Migration:

  - A provider must declare `capabilities`; without it, it no longer type-checks. A `syncCatalog(projection: unknown): Promise<void>` must become `syncCatalog(manifest, opts?): Promise<CatalogSyncReport>`.
  - Code that switches on `RailFact.type` or `FactOutcome.type` must handle `renewal_failed` and `subscription_ended`; code that switches on a refund, refund reversal or dispute outcome must handle `deferred`; `FactOutcome` of a payment may carry `deferred`. `PeriodRecord.closedReason` adds `canceled` and `unpaid`.
  - A host whose `BillingStateStore` does not implement `deferFact` / `takeDeferred` keeps the previous behaviour: a refund, a refund reversal or a dispute received before its payment returns `unknown_payment` and writes nothing. That host must keep such facts and replay them once the payment is known. Kept facts apply only when the payment goes through `handleRailFact`, not `applyPayment` called directly.
  - `FakeSettlementProvider` signatures are now an HMAC of the body: build test requests with `signed()` or `events()`, not by copying the webhook secret into the header.

- bf015f6: **Breaking (pre-1.0 minor).** Fix six defects of the settlement path that a real payment rail hits on day one.

  - **A first fact no longer freezes a payment.** The replay is decided on the effect, not on the fiat mint: a payment refused and listed as owed (offer missing in the first event, say) is completed once by a valid fact of the same movement, same amount and same currency, giving the same journal as the complete fact alone. A fact of the same movement with another amount or currency writes nothing and returns the new `conflict` outcome with both versions.
  - **Amount checks follow how rails bill.** `PaymentFact` gains `taxBehavior` (`inclusive` by default, or `exclusive`: the tax is on top of the price) and `discountMinor`. The price is compared with `amountMinor - (exclusive ? taxMinor : 0) + discountMinor`. A discount is accepted only on an offer with `discounts: allow`. A zero payment opens a trial period on a subscription offer with `subscription.trial` (an ISO 8601 duration), and is refused elsewhere. Proration is still not accepted.
  - **A partial refund no longer closes the period.** Refunds and lost disputes of one payment add up; credits are taken back for the slice each one adds, the total capped at the payment, and the subscription period closes only once the whole payment is taken back.
  - **Reversed refunds.** New fact `RefundReversedFact` (`type: "refund_reversed"`) and `applyRefundReversal`: a refund that failed or was canceled after it succeeded gives back the credits it took (same partitions and expiries) and reopens the period. `handleRailFact` dispatches it.
  - **Disputes carry an amount.** `DisputeFact` gains `amountMinor` and `currency`. `opened` freezes the credits that amount stands for (no longer the whole account), `lost` takes back that share, `won` after `lost` gives the credits back and reopens the period, and several disputes of one payment are each handled by their own movement. An inquiry that moves no money is not a dispute: a rail returns no fact for it.
  - **Refund idempotency.** `SettlementProvider.refund(movement, amountMinor, ref)` takes the caller's reference, used as the idempotency key at the rail, so two refunds of the same amount on one payment are two refunds.
  - Dispute movements are kept as the rail gives them (`stripe:dp_...`); no prefix is checked.

  Migration:

  - A provider must fill `amountMinor` and `currency` on every `DisputeFact`, emit no fact for a dispute inquiry, emit `RefundFact` only once a refund succeeded, and emit `RefundReversedFact` when it later fails or is canceled.
  - A provider's `refund` takes a third argument `ref` and must use it as the rail's idempotency key; a caller must pass a reference unique to each refund it asks for.
  - Code that switches on `PaymentOutcome.status` must handle `conflict`. The case "incomplete fact, then complete fact" now returns `applied` for the second fact (it was `replayed`).
  - The new refund marker is `<refund movement>:refund:<amountMinor>` on the payment's fiat lot (it was `<refund movement>:refund` on a credit lot). Refunds written by an earlier version do not count toward the cumulative share.
  - `BILLING.md` gains two optional offer fields, `discounts` and `subscription.trial`; existing manifests are unchanged.

- bc39e63: Add `@agentproto/billing/spend` (`createHolds`: reserve before a metered action, settle at the real cost capped to the reserve, release on failure, sweep the holds a crash left open, all idempotent by key, on the AIP-49 `reserve`/`capture`/`release` verbs) and `guardVoiceCall` in `@agentproto/voice` (authorize before the call opens, poll a balance checkpoint with warn and cutoff, settle in a `finally`).

  Contract tests a host overlay runs on every upgrade are exported: `holdsContractCases` (`@agentproto/billing/contract-tests`) and `voiceBillingGateConformanceCases` (`@agentproto/voice/testing`).

- 912935b: Add `price`, `debit` and `shadow` to `@agentproto/billing/spend`, and the contract tests at `@agentproto/billing/contract-tests`. `createPricer` turns a metered event into minor units of the primary asset from a usage category (measured, fixed or catalog cost) with one rate derived from the manifest anchor and an unpriced event that fails closed (margins and floors come from the host's configuration; the kit has no value of its own). `createDebit` spends on the journal's `burn` verb, idempotent by key, with a shortfall behaviour the caller names (`refuse` or `absorb`, no default) and named, ordered, pure `rules` that decide an amount or a refusal, which the core executes (a rule can only lower the amount, never write the journal; the result names the rule that decided). `createShadow` prices and records an event outside the journal and refuses to start without a pricer or a sink. `spendContractCases` is an exported suite of the invariants no rule can lift, to run in a host's CI at every kit bump.
- 243e055: Read the optional `usage` section of `BILLING.md` (categories as data: `match`, `cost` measured / catalog / fixed, `margin` or `at-cost`, `marginFloor`, `floorMinor`) into the manifest handle, through the zod schema and the vendored `BILLING.schema.json` (kept in step by the drift test). A category that writes its own rate is refused, as are duplicate ids, `at-cost` with a `marginFloor` above 1 and a fixed cost in a currency with no rate. The handle's `usage` feeds `createPricer`.
- 495ce4b: Add `usageReport` (`@agentproto/billing/spend`): per-category charged, cost and real margin from shadow entries (one count per event key, unpriced events apart, categories under their `marginFloor` named, an opaque `credentialSource` split), and the BILL-USE conformance cases (`billingUsageConformanceCases`, `@agentproto/billing/testing`, AIP-74 rules 29 to 35). `usageProblems` now refuses a category that writes its own rate.

### Patch Changes

- 58713bc: `@agentproto/billing-stripe`, call side: checkout, billing portal, refunds, catalog sync and the full provider factory.

  - **`createCheckout`**: return URLs checked against `allowedReturnOrigins`, owner keys, offer, quantity, buyer-amount bounds and trial all checked before any call; the price found by lookup key (refused when it drifted from the manifest) or `price_data` for a buyer amount; `agentproto_offer` and every `agentproto_owner_<key>` on the session and on `subscription_data.metadata`; promotion codes only with `discounts: allow`; trial days from `subscription.trial`.
  - **`createPortalSession`**: `billingPortal.sessions.create` with a checked return URL and the payer's customer id.
  - **`refund`**: `refunds.create` with `ref` as the idempotency key; a movement that is not `stripe:pi_...` is refused without a call; a refusal by Stripe comes back as `{ ok: false, error }` with every credential masked.
  - **`syncCatalog`** and the pure **`toStripeCatalog`**: one product per offer under a stable id, prices found by lookup key, a changed price replaced by a new one that takes the key over, never a delete, idempotent writes, `dryRun` read-only, degradations named by offer and field.
  - **`check()`** also reads `accounts.retrieveCurrent()` against `expectAccount` for the mode.
  - **Capabilities**: `refunds: "partial"`, `checkout`, `portal`, `catalogSync` on; `assertRailCapabilities` accepts a manifest on this rail. Every SET-* contract case runs, none declared unsupported.
  - **Options**: `createStripeProvider` now requires `manifest` and `allowedReturnOrigins`, and takes `expectAccount`, `automaticTax` and `rail`. `createProvider` is async: without a `client` it imports the `stripe` peer and builds it at `STRIPE_API_VERSION`, with a clear message when the package is missing.

  `@agentproto/billing`: the README points to the Stripe provider package.
  - @agentproto/product@1.0.5

## 0.1.0

### Minor Changes

- 8c6c692: Add `@agentproto/billing`: the BILLING.md parser and `defineBillingManifest`, the payment path on the AIP-49 wallet journal (one-time and subscription includes, drops, rollover, reclaim), the `SettlementProvider` contract, the provider registry, and the `BILL-*` conformance cases. No payment provider ships in this package.
- 692dd3b: Publish `@agentproto/billing` and `@agentproto/voice-assemblyai` to npm at 0.1.0: drop `"private": true` and add the standard `publishConfig.access: "public"` that every published `@agentproto/*` package carries. (`@agentproto/voice` was already made publishable in #2806.) Both ship their built `dist/` (`files: dist, README.md, LICENSE`), and their workspace dependencies (`@agentproto/provider-kit`, `@agentproto/doctype`, `@agentproto/product`, `@agentproto/wallet`) are already on npm, so `workspace:*` resolves at publish. First release for the two names; changesets bump `0.0.0` → `0.1.0` (minor).

### Patch Changes

- 9141b07: Replace the `AIP-BILLING` placeholder with the real number `AIP-74` in the package docs, comments and fixtures, and re-sync the fixture schema with the vendored AIP-74 BILLING schema.
- a1eabc8: `canPay` now counts the headroom of a lot minted with a `floor` (a bounded short position, or `null` for an unbounded one), the same bound the journal enforces on commit. Before, it summed `remaining` only, so an account the journal would let spend down to its floor read as unable to pay, and a postpaid-style lot at zero could never pass the affordability check.
- 5b792bc: Remove private product and repository names from comments, docs, examples and tests.

  `@agentproto/auth` no longer ships a vendor provider: the `acmeAuthProvider`-style builtin export is removed and `BUILTIN_AUTH_PROVIDERS` is empty, so the registry starts empty. A host declares its own provider with `parseAuthProviderManifest` (or `defineAuthProvider`) and `registerAuthProvider`, which already existed. Breaking for code that imported the old export or looked the old id up without registering it.

  `@agentproto/role-catalog`: the legacy role map export is now `LEGACY_OPERATOR_ROLE_MAP`.

  `@agentproto/apps` (session-steward): new `extraClosableOrigins` input appended to the closable origin list in force. The generic default roots are `orchestrator` and `orchestrator:*`; a host that stamps its own root label adds it with `extraClosableOrigins`.

  The private Replicate fine-tune entry is dropped from the model catalog.

- Updated dependencies [765660d]
- Updated dependencies [1741e68]
- Updated dependencies [5b792bc]
- Updated dependencies [89258dd]
  - @agentproto/provider-kit@0.7.0
  - @agentproto/wallet@0.3.1
  - @agentproto/doctype@0.2.0
  - @agentproto/product@1.0.5
