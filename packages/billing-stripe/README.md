# @agentproto/billing-stripe

The Stripe settlement provider of [`@agentproto/billing`](../billing) (AIP-74). **Webhook side**: it verifies Stripe webhooks, guards the mode, and turns the money events into the facts the core applies to the AIP-49 journal. **Call side**: checkout, billing portal, refunds and catalog sync. Nothing is written to the journal by this package: the core writes, from the verified fact only. A checkout writes nothing either: its money arrives by webhook.

```ts
import Stripe from "stripe"
import { STRIPE_API_VERSION, createStripeProvider } from "@agentproto/billing-stripe"
import { handleWebhook, railMode } from "@agentproto/billing"

const provider = createStripeProvider({
  secretKey: process.env.STRIPE_SECRET_KEY,
  webhookSecret: process.env.STRIPE_WEBHOOK_SECRET,
  mode: railMode(process.env.STRIPE_MODE),
  client: new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: STRIPE_API_VERSION }),
  manifest, // the loaded billing manifest
  ownerKeys: ["orgId"], // the manifest's payer.owner
  allowedReturnOrigins: ["https://shop.example.com"],
  expectAccount: { test: "acct_...", live: "acct_..." },
  onUnhandled: async (event, reason) => alerts.insert({ eventId: event.id, type: event.type, reason }),
})

await provider.syncCatalog!(manifest) // once per deploy; { dryRun: true } to see what it would do
const out = await provider.createCheckout!({ offerId: "pack-20", owner: { orgId }, accountId, successUrl, cancelUrl })

// In the webhook route, with the RAW body (not a re-serialised JSON):
await handleWebhook(deps, provider, { body: rawBody, headers })
```

Through the registry, `createProvider(ctx)` reads `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` and `STRIPE_MODE` from `ctx.env`, and the other options (`manifest`, `ownerKeys`, `allowedReturnOrigins`, `onUnhandled`, and the optional `client`, `offerNamespace`, `expectAccount`, `automaticTax`, `rail`) from `providerOptions.stripe`. Without a `client`, it imports `stripe` and builds it with the key at `STRIPE_API_VERSION`; when `stripe` is not installed, it fails with a message that says so.

`stripe` is an optional peer dependency: the code only calls a structural client (`StripeLike`: `invoicePayments.list`, `accounts.retrieveCurrent`, `refunds.create`, `checkout.sessions.create`, `billingPortal.sessions.create`, `products.list`, `products.create`, `products.update`, `prices.list`, `prices.create`; never a delete), which the SDK satisfies (a type test checks so).

## What this version does

- **Signature.** The public `Stripe-Signature` scheme, with `node:crypto`: HMAC-SHA256 of `${t}.${body}`, constant-time comparison, 300 s tolerance. Every `v1` of the header is read (several appear while a secret is rolled); any one that matches is enough; other schemes are ignored. A wrong, missing or stale signature throws, and nothing is written.
- **API version.** `STRIPE_API_VERSION` (`2026-11-18.endive`) is the API version this adapter reads, equal to the one `stripe@23` pins (a test compares the two against this package's own dev dependency). Whatever SDK version your host installs, set the webhook endpoint to `STRIPE_API_VERSION` and pass it as `apiVersion` to the client: an event of another version throws. The peer range is `stripe >=23.0.0` for that reason.
- **Mode and account.** `check()` refuses a missing key or webhook secret, and a key whose prefix (`sk_test_`, `rk_test_`, `sk_live_`, `rk_live_`) does not match `STRIPE_MODE`. With `expectAccount` set for the mode, it reads `accounts.retrieveCurrent()` and refuses a key of another account, or a restricted key that cannot read its account (give it that read access). An event whose `livemode` does not match the mode throws.
- **Scope.** A payment event without `metadata.agentproto_offer` gives no fact, nor does one outside `offerNamespace` when it is set: another product's payment is not listed as owed. Refunds and disputes carry no such metadata: they are emitted, and the core answers `unknown_payment` for another product's.
- **Payer.** Each key `k` of `ownerKeys` is read from `metadata.agentproto_owner_<k>`.
- **`onUnhandled` (required).** Called for every recognised money event that does not become an applicable fact. **Persist an alert there** (a table, a queue, a ticket), not a log line. When money arrived on the rail (an invoice settled by several payments), the journal itself keeps a trace too: the fact is marked `unsupported`, the core refuses it and lists the money as owed. When there is no usable movement (a refund without a payment intent, an invoice with both inclusive and exclusive taxes, a checkout total that holds shipping), `onUnhandled` is the only trace. Throwing there fails the webhook, so Stripe delivers it again.

### One source event per payment

| Payment | Source event | Fact |
|---|---|---|
| Checkout `mode: payment`, paid at once | `checkout.session.completed` with `payment_status: paid` | `payment`, movement `stripe:<payment_intent>`, amount `amount_total`, tax `total_details.amount_tax` (exclusive when `amount_total = amount_subtotal - discount + tax`), discount `total_details.amount_discount` |
| Checkout, delayed method | `checkout.session.async_payment_succeeded` | the same; `completed` with `unpaid` and `async_payment_failed` give nothing |
| Checkout that needed no payment | `checkout.session.completed` with `no_payment_required` | `payment` at 0, movement `stripe:<session id>` |
| Subscription, first payment and renewals | `invoice.paid` with `parent.subscription_details` | `payment`: offer and payer from `parent.subscription_details.metadata`, tax the sum of `total_taxes[].amount` (behaviour from `total_taxes[].tax_behavior`), discount the sum of `total_discount_amounts[].amount`, movement `stripe:<payment_intent>` read with `invoicePayments.list` (the event body does not carry the payments; a failed read throws, so Stripe retries) |
| Invoice at 0 (trial, full discount) | `invoice.paid` with `amount_paid: 0` | `payment` at 0, movement `stripe:<invoice id>`, no API read |
| Invoice not paid by exactly one payment intent equal to `amount_paid` | `invoice.paid` | one `payment` marked `unsupported`, movement `stripe:<invoice id>`: refused by the core, listed as owed, plus `onUnhandled` |
| Proration invoice | `invoice.paid` (`billing_reason: subscription_update`) | `payment` as is: the core refuses it (not the price) and lists it as owed |
| `payment_intent.succeeded`, `charge.succeeded`, `invoice.payment_succeeded`, `invoice_payment.paid`, a `mode: subscription` checkout | | none |

### Other facts

| Event | Fact |
|---|---|
| `refund.created`, `refund.updated`, `refund.failed` at `succeeded` | `refund`, movement `stripe:<re_...>`, payment `stripe:<payment_intent>`, the amount of this refund |
| the same at `failed` or `canceled` | `refund_reversed` |
| the same at `pending` or `requires_action` | none |
| `charge.refunded`, `charge.refund.updated` | none (`charge.refunded` carries a cumulative amount) |
| `charge.dispute.created`, `.updated`, `.closed`, `.funds_withdrawn`, `.funds_reinstated` | one rule on `dispute.status`: `warning_*` none; `needs_response`, `under_review`, `appeal_needs_response`, `appeal_under_review` `opened`; `won`, `prevented` `won`; `lost` `lost`. Movement `stripe:<dispute id>`, payment `stripe:<payment_intent>`, the dispute's amount and currency |
| `invoice.payment_failed` with `parent.subscription_details` | `renewal_failed`, movement `stripe:<invoice id>` |
| `customer.subscription.deleted` | `subscription_ended` at `ended_at`, reason `unpaid` when `cancellation_details.reason` is `payment_failed`, else `canceled` |
| anything else | none |

A scheduled cancellation (`customer.subscription.updated` with `cancel_at_period_end`) gives nothing: it can be undone, and the core already cuts the features at the period's end. If the account is set to keep unpaid subscriptions instead of deleting them, no `subscription_ended` is sent: the period closes through `sweepGrace` with the reason `grace_expired`. The features are cut either way.

## Calls

- **`createCheckout(req)`.** Everything that can be refused is refused before any call to Stripe: a success or cancel URL whose origin is not in `allowedReturnOrigins`, a missing owner key, an offer that is not sold on this rail or is outside `offerNamespace`, a quantity other than 1 (one payment buys one offer), an amount outside the offer's `minMinor` / `maxMinor` (buyer-chosen amounts), another amount on a fixed price, and a trial Stripe cannot carry. The mode follows the offer (`subscription`, else `payment`); a fixed price is the price found by its lookup key, refused when it is missing or differs from the manifest (run `syncCatalog`); a buyer amount is sent as `price_data`. The session carries `agentproto_offer` and every `agentproto_owner_<key>`, and so does `subscription_data.metadata` in subscription mode (the invoices read them there). `allow_promotion_codes` only on an offer with `discounts: allow`; `subscription_data.trial_period_days` from `subscription.trial`; `customer` from `payer.ref`, else `customer_email` from `payer.email`; `client_reference_id` is the account. The outcome is always `redirect`.
- **`createPortalSession(req)`.** `billingPortal.sessions.create` with the checked return URL; `payer.ref` (the Stripe customer id) is required.
- **`refund(movement, amountMinor, ref)`.** `refunds.create({ payment_intent, amount }, { idempotencyKey: ref })`: the same `ref` twice is one refund at Stripe. A movement that is not `stripe:pi_...` (an invoice, a session at 0) is refused without a call. A refusal by Stripe (more than what is left, say) comes back as `{ ok: false, error }` with Stripe's code and message, every credential masked. The money fact of the refund still comes by webhook, once it has succeeded.
- **`syncCatalog(manifest, { dryRun })`.** `toStripeCatalog(manifest)` is a pure projection (exported): one product per offer under a stable id (`ap_<productTag>_<offer>`), one price per fixed-amount offer with the lookup key `rail.stripe.lookupKey` when the offer keeps an existing one, else `<productTag>:<offer>` (the bare offer id without a `productTag`), `agentproto_offer` in the metadata of both. The sync reads the products by id and the prices by lookup key, creates what is missing, reactivates an archived product, and replaces a price that changed with a new one that takes the lookup key over (`transfer_lookup_key`); the old price is kept for the subscriptions still billing on it. Nothing is ever deleted; writes carry an idempotency key derived from their content; a dry run only reads and returns the same report. Degradations, by offer and field: included credits (`includes`) and their `includes.rollover`, the `conversion.bonus` (the core mints them from the payment fact), `subscription.anchor: calendar` (Stripe bills from the payment date), `subscription.onUpgrade: prorate` (a proration invoice is refused by the core and listed as owed), a `subscription.trial` that is not a whole number of days (its checkout is refused), a billing interval past Stripe's three years and a vendor price model (not sold on Stripe), an offer outside `offerNamespace`.
- **`automaticTax: { taxBehavior }`.** Enables Stripe Tax on every checkout, and sets that tax behaviour on the prices the sync writes. The payment fact reads the tax back either way.

## Capabilities

`oneTimePayments`, `buyerAmount`, `subscriptions`, `trials`, `discounts`, `checkout`, `portal`, `catalogSync`, `refundReversals`, `disputes`, `taxReported`: yes. `refunds: "partial"`, `moneyFacts: "self"`, `balanceAuthority: "journal"`. Each flag matches a method that exists (SET-6), and `assertRailCapabilities` accepts a manifest on this rail.

Not served, and declared so:

- `offSessionCharge: false`: `charge()` and `pay()` answer `{ ok: false, error: "unsupported" }`. The AIP-49 port gives `charge` no offer and no payer, so an off-session payment could not be tied to one.
- `payouts: false`, `remoteHolds: false`.

## Tests

- The SET-* contract cases of `@agentproto/billing/contract-tests` run against this provider, with the kit's in-memory stores, in test and live mode. None is declared unsupported.
- Each Stripe rule of the webhook side (two `v1`, mode, secrets, SET-13 to SET-23, the failed invoice payment read) and of the call side (no secret in refund and account errors, the expected account, return URLs, two syncs and a dry run, owner keys, the refund movement and idempotency key) is written once against a provider maker, and runs against this adapter and against a naive version kept in the tests (a direct switch on the event type; calls made at once, without the checks), on which each must fail, or say why it does not.
- **The fixtures are built by hand from Stripe's public API reference, not recorded** from an account: ids are invented and consistent within a set, and requests are signed in the test with a secret made for each run. The calls go to an in-memory Stripe double, never to Stripe. Their fidelity to a live Stripe account is still to be checked in test mode. A test refuses a fixture with a name of the repository's private list, an e-mail outside `example.com`, or a `stripe.com` URL.

## License

Apache-2.0
