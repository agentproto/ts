# AIP-55 — Product (pricing capability) · Implementer Guide

> **Status:** Draft (v2 — capability form)
> **Schema:** `PRODUCT.schema.json`
> **Reference runtime:** `@agentproto/product`
> **Depends on:** AIP-54 (`ref/v1`) — this spec's `on` field IS an AIP-54 ref.

## What is a Product?

A Product is **a pricing capability attached to any referenced AIP
artifact**. It is not a wrapper doctype: there is no per-target-kind
union, no `appRef`/`packRef`, no inlined handles. The target is
addressed by an AIP-54 `ref/v1` and needs zero pricing awareness —
"sandbox has a price" is expressible without the sandbox AIP changing.

A Product IS NOT:

- an AIP-49 wallet `asset` — AIP-49 models value *movement*; AIP-55
  models the *catalog entry*. `defineAsset` is taken.
- an AIP-18 collection item — no money type, no discriminated union,
  `refKind` is collection-scoped.
- an AIP-40 extension of AIP-42 — pricing is not app-specific.

## Filesystem layout

```
products/
  <id>.md      ← one manifest per pricing capability
```

The markdown body (after the frontmatter block) is purely documentary.

## Manifest shape

```yaml
---
schema: product/v1
id: book1-coder
kind: pricing
title: book1 companion — coder
description: Open-source companion code, pay per call.
on: aip://14/coder                 # AIP-54 ref — the ONLY reference field

price:
  model: pay-per-call
  unitPriceMinor: 2
  currency: usd
  meter: agent-call

billingRail:
  rail: stripe
  priceId: price_metered_1
  meterId: meter_abc
  recurrence: month
```

## Normative fields

| Field | Req | Notes |
|---|---|---|
| `schema` | MUST | `product/v1` |
| `id` | MUST | kebab-case |
| `on` | MUST | AIP-54 `ref/v1`. May also be given as the `aip://<aip>/<id>[@version]` string form, which implementations MUST normalize (parse + validate) into `ref/v1` before storing. The target AIP needs zero pricing awareness. Hosts MUST refuse unresolvable refs. |
| `price` | MUST | Discriminated on `model`: `one-time` \| `prepaid-pool` \| `pay-per-call`. **Minor units are normative.** |
| `billingRail` | MAY | Projection config, never the price's source of truth. See § Billing rails. |
| `kind` | MUST | `pricing` (fixed — this AIP defines the pricing capability; future capability kinds may share the pattern). |
| `title`, `description`, `metadata` | MAY | |

## Billing rails

The rail is **config, not truth**. A generator derives the provider
objects from `price`; the ids stored on the rail are caches of the last
projection.

- **`stripe`** — `one-time` → Product + `one_time` Price (1:1, no leak).
  `pay-per-call` → metered Price **plus a Stripe Meter**, created
  out-of-band: `meterId` is REQUIRED. `prepaid-pool` has NO native
  Stripe primitive — pool state lives host-side on every rail; Stripe
  only initiates the top-up payment.
- **`autumn`** — natively models both metered usage and prepaid credit
  grants; both metered shapes project onto one `featureId`. No leak.
- **`tbd`** — shape decided, provider not chosen.
- **Vendor rails** — open, config rides along.

## Worked examples (Agentik verticals)

```yaml
# book1/coder — open repo, pay-per-call
schema: product/v1
id: book1-coder
kind: pricing
on: aip://14/coder
price: { model: pay-per-call, unitPriceMinor: 2, currency: usd, meter: agent-call }
billingRail: { rail: stripe, meterId: meter_abc, recurrence: month }
```

```yaml
# book3/SEO — private bundle, prepaid pool
schema: product/v1
id: book3-seo
kind: pricing
on: aip://14/seo-private@1.2.0
price: { model: prepaid-pool, unitPriceMinor: 5, currency: usd, grantUnits: 200 }
billingRail: { rail: autumn, featureId: seo-credits }
```

```yaml
# default vertical — book + private app bundle, one-time
schema: product/v1
id: bookN-companion
kind: pricing
on: aip://42/book-companion
price: { model: one-time, amountMinor: 4900, currency: usd }
billingRail: { rail: tbd }
```

## Implementation sketch (TS path)

```ts
import { attachPricing } from "@agentproto/product"
import { refFor } from "@agentproto/ref"

const cap = attachPricing(refFor(appSpec, appHandle, "1.2.0"), {
  model: "one-time", amountMinor: 4900, currency: "usd",
})
```

"a collection of priced things" = `collectPriced(products, ref =>
catalog.resolve(ref))` — returns `{resolved, dangling}`: `resolved` pairs
each product with its resolved target, and `dangling` lists the products
whose `on` ref did not resolve, so a host can surface them instead of
having them silently dropped from the collection.

## Residual risks (from dogfooding)

1. **AIP-52's legacy `pricing` block** (unitless `{ebook?, bundle,
   step?}`) predates this spec. THIS product's price is authoritative;
   hosts SHOULD warn when a pack's `pricing` diverges from a pricing
   capability attached to it.
2. **Stripe prepaid-pool leak is inherent**: Stripe has no credit-pool
   concept; pool state lives host-side on every rail. The schema says
   so rather than implying a clean projection.
3. **Autumn composes cleanly for both metered shapes.**
