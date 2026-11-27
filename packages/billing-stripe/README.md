# @agentproto/billing-stripe

The Stripe settlement provider of [`@agentproto/billing`](../billing) (AIP-74), **webhook side**: it verifies Stripe webhooks, guards the mode, and turns the money events into the facts the core applies to the AIP-49 journal. Nothing is written by this package: the core writes, from the verified fact only.

```ts
import Stripe from "stripe"
import { STRIPE_API_VERSION, createStripeProvider } from "@agentproto/billing-stripe"
import { handleWebhook, railMode } from "@agentproto/billing"

const provider = createStripeProvider({
  secretKey: process.env.STRIPE_SECRET_KEY,
  webhookSecret: process.env.STRIPE_WEBHOOK_SECRET,
  mode: railMode(process.env.STRIPE_MODE),
  client: new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: STRIPE_API_VERSION }),
  ownerKeys: ["orgId"], // the manifest's payer.owner
  onUnhandled: async (event, reason) => alerts.insert({ eventId: event.id, type: event.type, reason }),
})

// In the webhook route, with the RAW body (not a re-serialised JSON):
await handleWebhook(deps, provider, { body: rawBody, headers })
```

Through the registry, `createProvider(ctx)` reads `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` and `STRIPE_MODE` from `ctx.env`, and `client`, `ownerKeys`, `onUnhandled`, `offerNamespace` from `providerOptions.stripe`.

`stripe` is an optional peer dependency: the code only calls a structural client (`StripeLike`, one method: `invoicePayments.list`), which the SDK satisfies (a type test checks so).

## What this version does

- **Signature.** The public `Stripe-Signature` scheme, with `node:crypto`: HMAC-SHA256 of `${t}.${body}`, constant-time comparison, 300 s tolerance. Every `v1` of the header is read (several appear while a secret is rolled); any one that matches is enough; other schemes are ignored. A wrong, missing or stale signature throws, and nothing is written.
- **API version.** `STRIPE_API_VERSION` (`2026-11-18.endive`) is the version the installed SDK pins (a test compares the two). Set the webhook endpoint to it: an event of another version throws.
- **Mode.** `check()` refuses a key whose prefix (`sk_test_`, `rk_test_`, `sk_live_`, `rk_live_`) does not match `STRIPE_MODE`; an event whose `livemode` does not match the mode throws.
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

## Capabilities of this version

`oneTimePayments`, `buyerAmount`, `subscriptions`, `trials`, `discounts`, `refundReversals`, `disputes`, `taxReported`: yes. `moneyFacts: "self"`, `balanceAuthority: "journal"`.

Not yet, and declared so (each flag matches the absence of its method):

- `refunds: "none"`: no `refund()`. Since AIP-74 forbids selling an offer whose refund path cannot run, `assertRailCapabilities` refuses a manifest on this rail until refunds land.
- `checkout`, `portal`, `catalogSync`: `false`; no `createCheckout`, `createPortalSession`, `syncCatalog`. The SET-10, SET-11 and SET-12 contract cases are declared unsupported.
- `offSessionCharge: false`: `charge()` and `pay()` answer `{ ok: false, error: "unsupported" }`. The AIP-49 port gives `charge` no offer and no payer, so an off-session payment could not be tied to one.

**Next version:** `refund()` (`refunds: "partial"`, idempotency key = the caller's ref), `createCheckout` (return URLs checked before any call, `agentproto_offer` and every `agentproto_owner_<key>` on the session and on `subscription_data.metadata`, trial days), `createPortalSession`, `syncCatalog` (prices found by `lookup_key`, never deleted, `dryRun` read-only, degradations named), and a fuller `createProvider` (the SDK imported when no client is given, `accounts.retrieve()` checked against an expected account in `check()`).

## Tests

- The SET-* contract cases of `@agentproto/billing/contract-tests` run against this provider, with the kit's in-memory stores.
- Each Stripe rule (two `v1`, mode, secrets, SET-13 to SET-23, the failed invoice payment read) is written once against a provider maker, and runs against this adapter and against a naive translation kept in the tests (a direct switch on the event type), on which each must fail, or say why it does not.
- **The fixtures are built by hand from Stripe's public API reference, not recorded** from an account: ids are invented and consistent within a set, and requests are signed in the test with a secret made for each run. Their fidelity to a live Stripe account is still to be checked in test mode. A test refuses a fixture with a name of the repository's private list, an e-mail outside `example.com`, or a `stripe.com` URL.

## License

Apache-2.0
