# Proposal: a `defineProduct` primitive (suggested AIP-53)

Status: pre-implementation design note. No spec draft, no package, no
implementation — this is the "should we, and what shape" document.

## 1. Survey — what exists today

Searched every `@agentproto/*` package for anything modeling a priced,
sellable thing (grep across `price|pricing|billing|product|sku|catalog|
commerce|entitlement|subscription`, plus reading the named candidates
below).

**Finding: nothing in the repo models a sellable thing with a price. Not
even partially.** The closest packages are adjacent in different axes:

| Package | AIP | What it actually models | Verdict |
|---|---|---|---|
| `packages/wallet` (`src/asset.ts`) | 49 | Principal-owned multi-asset wallet: `AssetRef`/`AssetStandard` (iso4217/erc20/…), partitions, lots, `SettlementNetwork` including `"stripe"`. **Value movement, not catalog.** | Adjacent — no product, no price, no kind-of-goods. Also note it already occupies the name `Asset` (`defineAsset` = wallet asset declaration), which rules out `defineAsset` for this. |
| `packages/app-kit` (`src/types.ts:224,285` `AppDefinition.category`) | 42 | Freeform string for coarse grouping in catalogs/trees ("book"). | Adjacent — a shelf label, not a product/price primitive. |
| `packages/pack` | 52 | `PACK.md` — bundles plugin + apps + knowledge + playbook into one **installable** unit. | Adjacent — distribution container, no price/billing concept. |
| `packages/catalog` (`agentcatalog/v1`) | — | Multi-source, tier-aware fetch surface over skills/operators/runtimes. | Adjacent — discovery/dedup, no commerce fields. |
| `packages/collection` | 18 | `Schema`/`Item` doctypes: typed fields, statuses, ownership, lints. | Mechanism candidate (see §2) — its `FieldDef` has no money type. |
| `packages/knowledge` | 10 | KNOWLEDGE.md entries/sources/workspaces. | No pricing. `knowledge-cascade` (not AIP-numbered) is a mount/overlay FS primitive — file shadowing, no commerce. |
| `packages/extension` | 40 | Extends another AIP's schema with `add_fields`/`tighten`. | Mechanism candidate (see §2). |
| `packages/auth` (`eligibility.ts` etc.) | — | "subscription" here means *auth subscription* (Claude-code-style login plans), not billing. | False positive. |
| `packages/model-catalog` | — | LLM/image/video/audio cost data (per-token pricing for models). | Adjacent — price-of-a-model, not price-of-a-sellable-product; explicitly OSS-core-only ("@agstudio/model-catalog layers billing/access on top"). |

## 2. Design choice: new AIP vs reuse

Three plausible carriers, argued against:

- **AIP-18 collection Item ("product" as a collection).** Tempting —
  a product catalog *is* a collection of records. But AIP-18's field
  types (`string|number|boolean|enum|date|...|ref|array`) have no money
  type and no discriminated-union shape; expressing `price: flat |
  prepaid-pool | pay-per-call` as flat collection fields loses exactly
  the union structure that makes billing generation possible. Collection
  is a *record-keeping* primitive; a product is a *typed handle* like
  `defineApp`.
- **AIP-40 extension of AIP-42.** Extensions add fields to an existing
  doctype. Pricing isn't app-specific metadata — a product can sell a
  book (content), a repo, a knowledge pack, or an app. Bolting `price`
  onto `AppDefinition` strands the non-app kinds.
- **New AIP.** A product is genuinely a new doctype family: it
  *references* other AIP artifacts (an AIP-42 app, AIP-10 knowledge, a
  git repo) but is not one of them, and it carries its own normative
  fields (price union, billing rail). This matches how the repo framed
  AIP-52 pack (a bundle referencing other doctypes).

**Verdict: new AIP.** Suggested number: **AIP-53** — the highest spec
present in `specs/resources/` is `aip-52` (pack); 51 has no directory
(gap). Next free is 53. *Flagged as a suggestion, not a claim of
authority.*

**Name: `defineProduct`, not `defineAsset`.** AIP-49 wallet already
ships `defineAsset` (`packages/wallet/src/define-asset.ts`) meaning
"declared unit of value" — reusing the name for "sellable thing" would
collide inside the same org's ecosystem. `Product` matches Stripe's
Product/Price model, which is the deliberate mental model. A product
*contains* assets; it is not one.

## 3. Proposed shape (sketch, not implemented)

Conventions followed: `define-doctype` prologue (`id`/`description`
invariant, frozen handle), freeform `id` + open string `kind` (same
stance as `AppDefinition.category`'s "freeform, not a closed enum"),
readonly handle, discriminated unions for price.

```ts
/** What is being sold. Open string union — new kinds need no AIP release. */
export type ProductKind =
  | "content"        // manuscript/corpus (AIP-10 knowledge, or raw md/pdf)
  | "repo"           // git repository (open-source or private bundle)
  | "app"            // an AIP-42 app bundle (AppHandle from @agentproto/app-kit)
  | "knowledge-pack" // a knowledge corpus mounted via knowledge-cascade
  | (string & {})    // extensible

/** The two real billing shapes in use, plus flat one-time. */
export type ProductPrice =
  | { model: "one-time"; amountMinor: number; currency: string }
  | { model: "prepaid-pool"; unitPriceMinor: number; currency: string;
      /** e.g. credits granted per purchase; pool semantics live downstream. */
      grantUnits: number }
  | { model: "pay-per-call";
      unitPriceMinor: number; currency: string;
      meter: string } // e.g. "agent-call", "tokens-1k"

/** Config pointing at a provider. Not the source of truth for the price. */
export type BillingRail =
  | { rail: "stripe"; priceId?: string; productId?: string }
  | { rail: "autumn"; featureId?: string }
  | { rail: "tbd" }
  | { rail: string & {}; config?: Record<string, unknown> } // extensible

/** The sellable thing. References existing AIP artifacts; never re-declares them. */
export interface ProductDefinition {
  readonly id: string            // kebab-case, validated by define-doctype
  readonly kind: ProductKind
  readonly description: string
  readonly version?: string      // semver of the product, not the price
  readonly price: ProductPrice
  readonly billingRail?: BillingRail

  /** Exactly one target, discriminated by `kind` (validated in `validate`). */
  readonly target?:
    | { kind: "content"; ref: string }          // path/url to manuscript or corpus
    | { kind: "repo"; ref: string; private?: boolean }  // git url / org/name
    | { kind: "app"; app: DoctypeHandle }       // an AIP-42 AppHandle — structural, no app-kit dep
    | { kind: "knowledge-pack"; pack: string }  // knowledge-cascade pack dir / AIP-10 workspace
    | { kind: string & {}; ref?: string }       // forward-compat
}

/** Frozen by the define-doctype prologue. */
export interface ProductHandle extends Readonly<ProductDefinition> {
  readonly schema: "product/v1"
}
// defineProduct(def: ProductDefinition): ProductHandle — via createDoctype
```

Key structural decisions:

1. **Wrap, don't duplicate.** `app` kind takes a structural
   `DoctypeHandle` (same trick `app-kit`'s `attach` uses,
   `packages/app-kit/src/types.ts:56`) so product-kit never depends on
   app-kit. `knowledge-pack` takes a reference, not AIP-10 fields.
2. **`billingRail` is projection config.** The `price` union is the
   source of truth; a generator maps it → Stripe Prices or Autumn
   features. `stripe.priceId` is a cache of the last sync, not the
   price itself.
3. **Minor units everywhere** — same lesson AIP-49 wallet encodes
   (`asset.ts:13`): amounts are minor units (cents), killing the
   ×100 bug class structurally.
4. **Discriminate on `kind` twice** (top-level and in `target`) and
   cross-check in `validate(def)` — the same "cross-field rules live in
   validate" pattern every generated schema package uses.

## 4. Agentik's three real cases

```ts
// 1. book1/coder — open code, pay-per-call
defineProduct({
  id: "book1-coder",
  kind: "repo",
  description: "book1 companion: coder, open-source",
  price: { model: "pay-per-call", unitPriceMinor: 2, currency: "usd",
           meter: "agent-call" },
  billingRail: { rail: "stripe" },
  target: { kind: "repo", ref: "github.com/agentik/coder", private: false },
})

// 2. book3/SEO — private bundle, prepaid pool
defineProduct({
  id: "book3-seo",
  kind: "repo",
  description: "book3 companion: SEO, private bundle",
  version: "1.2.0",
  price: { model: "prepaid-pool", unitPriceMinor: 5, currency: "usd",
           grantUnits: 200 },
  billingRail: { rail: "autumn" },
  target: { kind: "repo", ref: "github.com/agentik/seo-private", private: true },
})

// 3. default vertical — book (content) + private app bundle, one-time
defineProduct({
  id: "bookN-companion",
  kind: "app",
  description: "book companion app: private bundle",
  price: { model: "one-time", amountMinor: 4900, currency: "usd" },
  billingRail: { rail: "tbd" },
  target: { kind: "app", app: companionApp }, // AppHandle from defineApp()
})
```

## 5. What this deliberately does NOT include

- Entitlements/enforcement (who may call what) — AIP-49 wallet +
  restriction lattice already cover ledger-side; enforcement is a host
  concern.
- Subscription periods/renewals — no real second subscription shape is
  in use yet; `prepaid-pool` covers the credit-pool model. Add a
  `model: "subscription"` only when a real consumer exists.
- Tax/region/coupons — Stripe's job via the rail config.
