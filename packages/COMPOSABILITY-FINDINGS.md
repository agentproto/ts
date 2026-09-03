# Composability findings — defineProduct dogfooding

Companion to `PROPOSAL-product-primitive.md`. These are findings from
actually DRIVING the proposed primitive (a scratch vitest suite that
inlines the proposal's `defineProduct` and calls real `@agentproto`
packages from their built `dist/`), not a paper review. Scratch suite
lives (uncommitted) at `packages/wallet/scratch-dogfood.test.ts` — 13
tests, all passing, each `FLAW:` test asserts a verified misbehavior.

Cases driven for real:

1. **AIP-42 app** — `defineApp` from `app-kit/dist`, product target = the
   real `AppHandle`.
2. **AIP-49 wallet asset** — `defineAsset` from `@agentproto/wallet` with
   a real `AssetDeclaration` (`internal` standard, `settleOut:
   "internal-ledger"`).
3. **AIP-52 pack** — `definePack` from `pack/dist` with a real
   `PackDefinition` incl. its own `pricing` block.
4. **Plain content** — string ref, no artifact.
Plus rail-projection sketches for Stripe and Autumn on both metered
mechanics.

## Findings, ranked by severity

### F1 (critical): the `target` handle indirection does not resolve — it serializes the whole bundle

The proposal's `target: { kind: "app", app: DoctypeHandle }` was meant to
wrap/reference, but there is no projection step anywhere, so the FULL
`AppHandle` rides inside the product. Verified in
`packages/wallet/scratch-dogfood.test.ts:96-115` (`FLAW: nothing
rehydrates…`): after `JSON.parse(JSON.stringify(product))`,
`target.app` still contains `ui.html`, `agents`, `workflows`, `version`,
… — the entire bundle. And `AppHandle` never carries a `schema` field
(`app-kit/src/types.ts` `AppHandle` has no such property; `emit` writes
`schema: "app/v1"` into `APP.md` but the handle doesn't carry it), so the
proposal's `{id, schema?}` discriminator is `undefined` on the wire.

Worse: nothing rehydrates. app-kit's `load-app.ts` loads from a
DIRECTORY, not an id; there is no id→AppHandle resolver. A consumer
holding only the product cannot resolve `target.app` — the indirection
worked only in theory because nothing called `.resolve()` on it.

**Fix adopted in the AIP-53 draft:** `target.app` → `target.appRef`
(string id) + optional pinned `target.version`; anonymous AIP-42 apps
(verified: `defineApp({name, description, ui})` produces a handle with
`id === undefined`, `scratch-dogfood.test.ts:60-70` where AIP-43's
default `keyBy` throws on it) are declared unsellable — hosts MUST
refuse.

### F2 (high): AIP-52 packs key on `name`, not `id` — and already have their own price

- `PackHandle` = `{name, title, …}` — no `id`. Registering a real
  `definePack` handle into `createRegistry({family:"pack"})` throws
  (`scratch-dogfood.test.ts:139-149`): AIP-43's default keyBy inspects
  `id`/`provider`/`slug` and finds none. A custom `keyBy: h => h.name`
  works, but nothing in the proposal told hosts to do that.
- `PackDefinition.pricing` (`packages/pack/src/types.ts:69-73`) is a
  raw `{ebook?, bundle, step?}` — unitless numbers (49 = dollars?
  cents? unspecified), no currency, no metering. The same sellable
  bundle now has two prices that can drift; the dogfood asserts 49 ≠
  4900 (`…competing price models` test).
- The proposal's kind list had no way to sell a pack at all — the
  `knowledge-pack` target takes a cascade dir string, and I had to
  invent `kind: "pack"` outside the list.

**Fix adopted:** explicit `pack` target kind with `packRef` (the pack's
`name`); product price is authoritative, hosts SHOULD warn on
divergence from `pack.pricing`.

### F3 (medium): Stripe leaks on both metered mechanics

- **pay-per-call → Stripe**: Stripe's metered billing needs a separate
  out-of-band **Meter** object plus a recurrence; the proposal's rail
  shape had only `priceId`/`productId` — nowhere for `meterId`, forcing
  the `as BillingRail` config-payload hack (`scratch-dogfood.test.ts:
  190-199`). **Fix adopted:** `stripe` rail gains `meterId` +
  `recurrence`; `defineProduct`'s validate MUST refuse pay-per-call on
  stripe without `meterId`.
- **prepaid-pool → Stripe**: no native pool concept, full stop. Verified
  in projection sketch (`…no native pool concept` test): the pool state
  lives host-side on every rail; on Stripe the rail is only a payment
  initiator (top-up product or Customer Balance). `grantUnits` semantics
  never reach Stripe. This is inherent to Stripe, not a schema bug — the
  spec now says so explicitly instead of implying a clean projection.
- **Autumn composes cleanly for both** — metered usage and prepaid
  credit grants are native; both map to a single `featureId`. No leak.

### F4 (medium): open `kind` with no namespace → collision-prone

Verified: `defineProduct({kind: "credit-pool", target: {kind:
"credit-pool", ref: "SOMEONE_ELSES_CREDIT"}})` is accepted with zero
resolution or validation (`scratch-dogfood.test.ts:127-141`). The
wallet-backed case is real — Agentik's credit pool SHOULD bind to an
AIP-49 `AssetRef` — but the proposal gave no convention, so two vendors'
`credit-pool` kinds mean different things and none resolve.
**Fix adopted:** vendor kinds SHOULD be namespaced; the spec documents
that a wallet-backed target's `ref` MUST be the `AssetRef`. Residual:
SHOSTS cannot enforce a SHOULD — collisions remain possible.

### F5 (low): `attach` interaction — fine once targets are by-reference

With the original inline-handle design, `target.app` duplicated exactly
what AIP-42 `attach` carries (the handle) — two copies of the bundle in
one ecosystem, and the product's copy went stale on any app edit. With
`appRef`, the two compose cleanly: `attach` answers "what ships
together" (in-memory bundle), AIP-53 answers "what is sold" (catalog
entry by id). No field collisions.

### Composes fine (say so plainly)

- **`content`** — the registry-free string ref is the right shape;
  nothing to resolve, works as-is.
- **`one-time` ↔ Stripe** — 1:1 Product+Price, no leak.
- **`prepaid-pool` ↔ AIP-49 wallet** — minor units agree with the
  wallet's `decimals` convention; a pool backed by a wallet asset is
  the one place AIP-49 and AIP-53 slot together without glue
  (`scratch-dogfood.test.ts:118-127`).
- **both metered mechanics ↔ Autumn** — native fit, no hack.

## Method note

Scratch suite: `packages/wallet/scratch-dogfood.test.ts` (uncommitted;
inside `packages/wallet` only so vitest resolves sibling dists).
Imports `defineApp`/`definePack`/`createRegistry` from built `dist/`
and `defineAsset` from wallet src. Two fixture constraints hit while
driving (worth knowing): `defineApp` rejects apps with neither agents
nor `ui` (`define-app.ts:52`), and `defineAsset` requires
`ruleSet.settleOut` (`wallet/src/define-asset.ts:29`).
