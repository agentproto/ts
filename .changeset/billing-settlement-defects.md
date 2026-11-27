---
"@agentproto/billing": minor
---

**Breaking (pre-1.0 minor).** Fix six defects of the settlement path that a real payment rail hits on day one.

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
