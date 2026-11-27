---
"@agentproto/billing-stripe": minor
---

New package: the Stripe settlement provider of `@agentproto/billing`, webhook side.

- **Signature** verified with `node:crypto` (`t=`, every `v1`, constant time, 300 s tolerance); `STRIPE_API_VERSION` pinned to the installed SDK's version, an event of another version throws.
- **Mode guard**: `check()` refuses a key of the other mode; an event whose `livemode` disagrees throws.
- **Money facts**, one source event per payment: paid checkouts, subscription invoices (payment read with `invoicePayments.list`; an invoice not paid by exactly one payment intent becomes one `unsupported` fact, listed as owed), refunds from `refund.*` only, disputes by one rule on their status, `renewal_failed` and `subscription_ended`. Payments outside `agentproto_offer` / `offerNamespace` give no fact. `onUnhandled` is required.
- **Capabilities** honest for this version: no refund, checkout, portal, catalog sync nor off-session charge yet (`charge`/`pay` answer `unsupported`).
- The SET-* contract cases run against it; fixtures are built by hand from Stripe's public reference, not recorded.
