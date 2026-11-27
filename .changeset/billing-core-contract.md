---
"@agentproto/billing": minor
---

**Breaking (pre-1.0 minor).** The payment provider contract a real rail adapter needs: declared capabilities, checkout and portal, typed catalog sync, subscription facts, a provider factory, facts kept until their payment, and the SET-* contract cases.

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
