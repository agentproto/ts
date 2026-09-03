# AIP-53 — Product · Implementer Guide

> **Status:** Draft
> **Schema:** `PRODUCT.schema.json`
> **Reference runtime:** none yet (proposal; see `packages/PROPOSAL-product-primitive.md` for the dogfooding that shaped this draft)

## What is a Product?

A Product is **a sellable thing with a kind and a price** — Stripe's
Product/Price model, adapted for agent-ecosystem assets. A product
REFERENCES existing AIP artifacts (an AIP-42 app, an AIP-52 pack, AIP-10
knowledge, a git repo, a plain manuscript) but is not one of them: those
doctypes deliberately carry no commerce fields, and this one carries
nothing but.

A Product IS NOT a subtype of any existing doctype. In particular:

- It is NOT an AIP-49 wallet `asset` — AIP-49 models value *movement*
  (partitions, lots, settlement); AIP-53 models the *catalog entry*.
  The name `defineAsset` is already taken by AIP-49.
- It is NOT an AIP-18 collection item — AIP-18's field types have no
  money type and cannot express the price discriminated union.
- It is NOT an AIP-40 extension of AIP-42 — pricing is not
  app-specific; a product can sell a repo or a book with no app at all.

## Filesystem layout

```
products/
  <id>.md      ← one manifest per product (YAML frontmatter + prose body)
```

The markdown body (after the frontmatter block) is purely documentary —
it is not parsed by the runtime.

## Manifest shape

```yaml
---
schema: product/v1
id: book1-coder
kind: repo
title: book1 companion — coder
description: Open-source companion code, pay per call.
version: 1.0.0

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

target:
  kind: repo
  ref: github.com/agentik/coder
  private: false
```

The body is documentary.

## Normative fields

| Field | Req | Notes |
|---|---|---|
| `schema` | MUST | `product/v1` |
| `id` | MUST | kebab-case, `^[a-z][a-z0-9-]*$` |
| `kind` | MUST | open vocabulary (`content`, `repo`, `app`, `pack`, `knowledge-pack` core; vendor kinds SHOULD be namespaced). MUST equal `target.kind` when `target` is present — cross-field, enforced in `defineProduct(def)`'s `validate`, not in JSON Schema. |
| `description` | MUST | |
| `price` | MUST | Discriminated on `model`: `one-time` \| `prepaid-pool` \| `pay-per-call`. **Minor units are normative** (`amountMinor`/`unitPriceMinor`) — the same lesson AIP-49 encodes in `decimals`; major-unit floats are the ×100 bug class. |
| `billingRail` | MAY | Projection config, never the price's source of truth. See § Billing rails. |
| `target` | MAY | What the buyer receives; absent for pure pool top-ups. See § Targets. |
| `title`, `version` | MAY | |
| `metadata` | MAY | Vendor extensions, namespaced under `<vendor>`. |

## Billing rails

The rail is **config, not truth**. A generator derives the provider
objects from `price`; the ids stored on the rail (`priceId`,
`productId`, `featureId`) are caches of the last projection.

Known rails:

- **`stripe`** — `one-time` → Product + `one_time` Price (1:1, no leak).
  `pay-per-call` → a metered Price **plus a Stripe Meter**, which Stripe
  creates out-of-band: the meter id MUST be carried in `meterId`
  (overloading `priceId` is invalid). `prepaid-pool` has NO native
  Stripe primitive — the pool state lives host-side; Stripe only
  initiates the top-up payment (see § Composability findings).
- **`autumn`** — natively models both metered usage and prepaid credit
  grants, so `prepaid-pool` and `pay-per-call` both project onto a
  single `featureId` (`grantId` when the grant is a distinct object).
- **`tbd`** — commerce shape decided, provider not chosen.
- **Vendor rails** — `^[a-z][a-z0-9-]*$`, not colliding with the known
  three; `additionalProperties: true` so rail config rides along.

## Targets

A target references an artifact; it never inlines one:

- `content` — plain path/URL, deliberately registry-free.
- `repo` — git URL / `org/name`, plus `private`.
- `app` — **`appRef`** (the AIP-42 app's `id`), by reference. Do NOT
  inline an `AppHandle`: the in-memory handle carries no `schema`
  field and serializes to the whole bundle. Anonymous AIP-42 apps
  (no `id`) CANNOT be sold — hosts MUST refuse. Hosts SHOULD pin
  `target.version` at sale time.
- `pack` — **`packRef`** (the AIP-52 pack's `name` — packs key on
  `name`, not `id`). If the pack also carries its own `pricing` block,
  the product's price is authoritative; hosts SHOULD warn on
  divergence.
- `knowledge-pack` — cascade pack dir or AIP-10 workspace name.
- Vendor kinds — open, SHOULD be namespaced; if an AIP-49 wallet asset
  backs the target, `ref` MUST be the `AssetRef`.

## Implementation sketch (TS path)

```ts
import { createDoctype } from "@agentproto/define-doctype"

export const defineProduct = createDoctype<ProductDefinition, ProductHandle>({
  errorPrefix: "defineProduct (AIP-53)",
  schema: productFrontmatterSchema, // generated from PRODUCT.schema.json
  validate(def) {
    if (def.target && def.target.kind !== def.kind)
      throw new Error(`kind '${def.kind}' != target.kind '${def.target.kind}'`)
    if (def.price.model === "pay-per-call" && def.billingRail?.rail === "stripe"
        && !def.billingRail.meterId)
      throw new Error("pay-per-call on the stripe rail requires billingRail.meterId")
  },
  build(def) { return Object.freeze({ ...def, schema: "product/v1" }) },
})
```

## Composability findings (from dogfooding)

A scratch suite that actually drives `defineApp` (app-kit), `defineAsset`
(wallet), `definePack` (pack), and AIP-43 registries against an inlined
`defineProduct` found the following; this draft already incorporates the
fixes, but the residual risks are worth stating:

1. **Handle indirection does not resolve** (was the biggest flaw; fixed
   here by `appRef`/`packRef`). The original proposal carried a
   structural `DoctypeHandle` in `target.app` — verified: `AppHandle`
   has no `schema` field, and serializing the product inlined the whole
   app bundle (agents, workflows, UI HTML). Nothing downstream could
   rehydrate it: app-kit has no id→AppHandle lookup.
2. **Registry key mismatch** (residual): AIP-43's default `keyBy`
   inspects `id`/`provider`/`slug`. `PackHandle` has only `name` —
   registering one into a plain `createRegistry({family:"pack"})`
   throws; hosts must pass `keyBy`. `AppHandle` lacks `id` when
   anonymous — same failure. The spec now requires sellable artifacts
   to carry their registry key and documents the `name`-vs-`id` split.
3. **Two competing price models** (residual): `PackDefinition.pricing`
   (`packages/pack/src/types.ts:69-73`) predates this spec — a raw
   `{ebook?, bundle, step?}` number with no currency and no minor-unit
   convention. Spec resolves authority to the product and asks hosts to
   warn on drift, but packs and products can still silently disagree.
4. **Open `kind` has no namespace convention** (residual): nothing
   stops two vendors from both selling `kind: "credit-pool"` with
   different unit semantics. Spec says SHOULD be namespaced; hosts
   cannot enforce SHOULD.
5. **Stripe pool leak** (inherent, not fixable in the schema): Stripe
   has no credit-pool concept — `prepaid-pool` state lives host-side on
   every rail; on `stripe` the rail is only a payment initiator. On
   `autumn` both metered shapes are native and compose cleanly.
6. **`attach` interaction**: fine — a product references an app by id;
   app-kit's `attach` carries handles in-memory for a *bundle*. The two
   answer different questions (what is sold vs what ships together) and
   no field collides, provided products keep to `appRef` (the original
   inline-handle design did fight `attach`, duplicating bundle content).
