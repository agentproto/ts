# Proposal: Composable primitives — a typed reference primitive, capability attachment, and selective extension

Status: pre-implementation design note.

> **Numbering correction (2026-09-04):** this doc was drafted against
> `agentproto/ts`'s local `specs/resources/` as the source of truth and
> called the pricing capability "AIP-53". The canonical registry is the
> separate `agentproto/agentproto` repo, where 53 is already taken by
> APP.md (app/v1). Final numbers: **AIP-54 = REF** (unchanged),
> **AIP-55 = PRODUCT** (renumbered from 53). The references below have
> been renumbered in place.
 Supersedes the *architecture* of
`PROPOSAL-product-primitive.md` / the AIP-55 draft; AIP-55 itself becomes
the first consumer of this foundation rather than a one-off (see §5).

Companion dogfood: `packages/wallet/scratch-composable.test.ts`
(uncommitted scratch, 7 tests, all passing) — drives every primitive in
this doc against the real `@agentproto` packages (app-kit, pack, registry,
tool/AIP-14) from their built `dist/`. Everything claimed below marked
**[driven]** was executed by that suite, not asserted on paper.

Verification note: because the scratch suite is intentionally uncommitted
(this is a design note, not an implementation PR), claims marked
**[driven]** cannot yet be re-run by a reviewer from this diff alone. When
AIP-54/the capability primitive/AIP-40 v2 land as real implementation
PRs, the corresponding tests MUST be committed alongside the code they
drive, and every **[driven]** claim in this document must still pass
under those committed tests before that follow-up work merges. Nothing
marked **[driven]** here should be treated as settled until then.

## 0. The problem, restated precisely

Three primitives each reinvent referencing and composition:

| Primitive | Reference mechanism | Composition mechanism |
|---|---|---|
| AIP-18 collection | `ref` field → id string, scoped to ONE named collection (`specs/resources/aip-18/draft/COLLECTION.schema.json` `$defs.fieldDef.properties.refKind`: "The target collection's `name`. … items of this collection"); no shape guarantee | `extends` chain, merge-by-name |
| AIP-40 extension | n/a (single parent) | add/tighten-only monotonic merge, wholesale (`packages/extension/src/spec-from-extension.ts:9-22`) |
| AIP-55 product (draft) | bespoke `appRef`/`packRef` per target kind | one-off union |

Plus four more ad-hoc ref shapes in the wild: AIP-42's `AnyRef`
(`string | {ref|file|inline}`, `packages/agent/src/types.ts:13-21`),
`ws://<family>/<slug>` URIs (AIP-18 appliesTo, AIP-20, role sources),
AIP-52 harness's `$resolver`, and app-kit's structural `DoctypeHandle`
(`packages/app-kit/src/types.ts:56`). Six mechanisms, zero interop.

The tell: AIP-55 needed `appRef` AND `packRef` AND a knowledge-pack
string. Every future primitive that references anything would add
another. The gap is one level below AIP-55.

## 1. Primitive A — typed artifact reference (suggested **AIP-54**, `ref/v1`)

### Shape

```ts
/** Canonical reference object. One of these replaces every xRef field. */
export interface ArtifactRef<A extends number = number> {
  readonly aip: A              // owning AIP number — the type discriminator
  readonly id: string          // the family's registry key
  readonly version?: string    // pinned; absent = floating
}
// Optional URI serialization for YAML/JSON-string contexts:
//   aip://<aip>/<id>[@version]     e.g. aip://42/book-companion@1.2.0
```

**URI serialization — status: TBD for implementation, not [driven].** The
sketch above is unvalidated and deliberately left underspecified here;
before it ships as part of AIP-54 it needs:

- **Escaping/encoding of `id`.** Registry keys are free-form strings today
  (slugs, dotted names, etc.) and may contain `/`, `@`, or other URI
  metacharacters. The serialization needs either a restriction on legal
  `id` characters (e.g. registries already require slug-safe keys) or a
  percent-encoding rule, decided per-family at the `RefCatalog`
  registration point, not left to callers.
- **Parsing rule for the optional `@version` suffix.** The rule is "split
  on the last unescaped `@`"; if `id` itself may legally contain `@`
  (unlikely for slugs, but not yet forbidden), that ambiguity must be
  closed by the same `id`-character restriction above.
- **Backwards compatibility with existing URI schemes.** `aip://` is a new
  scheme and does not collide with `ws://` (AIP-18 `appliesTo`, AIP-20)
  or `http(s)://` (AIP-52 `$resolver`) — those remain valid as
  string-typed `AnyRef`/`$resolver` values and are not retroactively
  reinterpreted. `ref/v1`'s typed `{aip, id, version?}` form is the
  primary representation; `aip://` URIs are only a convenience
  serialization for string-only contexts (YAML scalars, query params)
  and MUST round-trip losslessly through the object form.

None of the above is exercised by the dogfood suite; the object form
(`ArtifactRef` as a plain TS value) is what `refFor`/`RefCatalog` use and
is what's [driven]. Treat the `aip://` string format as a proposed
convention to be finalized — with an explicit grammar and test coverage
— during AIP-54 implementation, not as settled by this note.

### The two halves

A reference is only as good as its resolution. Both halves exist
already — they just aren't connected:

- **Handles** come from every `defineX` (`createDoctype` prologue,
  `packages/define-doctype/src/index.ts`).
- **Registries** exist generically per family: AIP-43's
  `createRegistry<H>({ family, keyBy })`
  (`packages/registry/src/create-registry.ts:38`) is already
  type-parametric over ANY handle and already refuses duplicates.

The missing 20 lines are the join:

```ts
export class RefCatalog {
  private byAip = new Map<number, { family: string; registry: Registry<never> }>()
  registerFamily(aip: number, family: string, registry: Registry<never>): void
  resolve(ref: ArtifactRef): { handle: unknown; family: string } | undefined
}

export function refFor<A extends number, H>(
  spec: { aip: A; keyBy?: (h: H) => string },
  handle: H,
  version?: string,
): ArtifactRef<A>
```

**[driven]** `refFor` derives refs from REAL `AppHandle`s, `PackHandle`s,
AIP-14 `ToolHandle`s, and a scratch sandbox handle; one `RefCatalog`
resolves all four back to the *same object identity* (`toBe`), and an
unresolvable ref returns `undefined` loudly — never a dangling id string.

### Why this shape and not the alternatives

- **Not AIP-18's `refKind`:** collection-scoped, singular, untyped.
  A ref must cross AIPs; `refKind` structurally cannot.
- **Not app-kit's `DoctypeHandle` alone** (`{id, schema?}`): it names the
  shape but not *which* registry owns it, and (driven finding, §5) real
  handles don't reliably carry `schema`. `aip` is the discriminating,
  always-present coordinate.
- **Not AIP-42's `AnyRef` string form:** strings are the *wire format*,
  not the type. `ref/v1` is the typed layer above them.
- **Version pinning on the ref, not the target:** the referenced
  artifact evolves; the ref records what was meant at authoring time.
  This is what AIP-55's `target.version` was reaching for — now
  inherited for free.

### What existing mechanisms become

- AIP-18 `ref` fields → validated as `ref/v1` URIs; `refKind` becomes
  "the `aip` this field accepts" (or a set of them). The singular-
  collection limitation dissolves.
- app-kit `attach` → carries `ArtifactRef`s instead of structural
  handles (fixes the serialize-the-whole-bundle flaw from the first
  dogfood round).
- AIP-52 `$resolver` → a URI rendering of `ref/v1`.
- AIP-42 `AnyRef` → unchanged at the string layer; `ref/v1` is the
  typed superset hosts narrow to.

## 2. Primitive B — capability attachment, not wrapper-per-target-kind

AIP-55 as drafted inverts badly: it's a Product that *contains* a target,
requiring a bespoke `appRef`/`packRef`/`knowledge-pack` union per kind.
Invert it: **a capability is attached TO an artifact via the general
ref**, and knows nothing about the target's kind.

```ts
export interface CapabilityDefinition {
  readonly id: string
  readonly kind: "pricing" | (string & {})   // open: future kinds welcome
  readonly on: ArtifactRef                    // THE general reference
  readonly payload: unknown                   // typed per `kind`
}
export interface CapabilityHandle extends Readonly<CapabilityDefinition> {
  readonly schema: "capability/v1"
}
export function defineCapability(def: CapabilityDefinition): CapabilityHandle
```

`pricing` is the first capability kind; its payload is exactly AIP-55's
`price` union + `billingRail` (unchanged — see the AIP-55 draft). The
"product" concept becomes: *a pricing capability attached to something*.
"a collection of priced things" = filter the capability registry by
`kind === "pricing"`, join on `on.aip`/`on.id`.

**[driven]** the SAME `attachPricing(ref, price)` call priced:
1. a real AIP-42 app (`defineApp` from app-kit dist),
2. a real AIP-52 pack (`definePack`, `pricing` block deliberately
   ignored — the capability is authoritative),
3. a real AIP-14 tool (`defineTool` / `toolSpec` — an AIP that has
   *never heard of* pricing),
4. a hypothetical AIP-61 sandbox (scratch-typed, `provider`/`id` only).

All four capabilities are one shape, filterable as one collection. The
sandbox AIP required **zero** changes — this is the proof the pattern
generalizes and isn't product-specific plumbing.

### What "tool has a price" means concretely

```ts
const tool = defineTool({ id: "search-web", … })            // AIP-14, unchanged
const price = attachPricing(refFor(toolSpec, tool),
  { model: "pay-per-call", unitPriceMinor: 2, currency: "usd", meter: "tool-call" })
```

No tool-spec change, no product-target union, no new AIP per kind. A
future sandbox AIP just needs to be a *registry citizen* (AIP-43
family + a registry key), which it needs for its own reasons anyway.

## 3. AIP-40 redesign — selective composition

Today's extension (`packages/extension/src/schema.ts`; composition in
`packages/extension/src/spec-from-extension.ts:9-22,127-134`) merges
five aspects wholesale: `schema = parent ∪ add_fields`, `path = ext ??
parent`, `defaults` layered, `parse = parent.parse`. No removal, no
per-aspect choice — an extension cannot keep an app's identity and drop
its agents.

Proposed surface (backward-compatible; omitted = today's behavior,
**[driven]** by the back-compat test):

```yaml
# EXTENSION.md v2 — additions only
remove_fields: [agents, workflows]   # GUARDED, see below
inherit:                             # per-aspect selection
  schema: true        # default
  defaults: true      # default
  parse: false        # take schema, supply your own parser
  path: true          # default
add_fields:
  properties:
    price: { $ref: "https://agentproto.sh/schemas/aip-55/PRODUCT.schema.json#/$defs/price" }
```

Guards (normative):

1. **`remove_fields` cannot remove a parent `required[]` field.** This
   mirrors AIP-18's own rule — "Children … MUST NOT remove an inherited
   status" (`packages/collection/src/types.ts:53`). Removing required
   fields would invalidate parent-validated instances.
2. Removed fields are *enforced away*: the composed `define` rejects
   inputs carrying them (**[driven]**), not just dropped silently.
3. `parse: false` requires the extension to supply its own parser (the
   root-doctype situation AIP-40 already handles —
   `spec-from-extension.ts:177-190`), otherwise registration throws.

**[driven]** scenario, verbatim Jeremy's: *"keeps an app's identity
fields but drops agents/workflows and adds a price"* — composed spec
keeps `id`, rejects `agents` (guard), accepts `{id, description, price}`
through `define`, and uses the extension's parser while inheriting the
parent's schema. AIP-40 v1's shape cannot express this at all.

## 4. What still does NOT compose (honest residuals)

1. **Handles don't self-describe.** Real `AppHandle` has no `schema`
   field (emit writes `schema: "app/v1"` into `APP.md`, the in-memory
   handle never carries it — **[driven]**
   `scratch-composable.test.ts`, residuals describe), so `refFor` needs
   the spec supplied explicitly and a bare serialized handle can't
   become a ref. Normative fix: AIP doctype handles SHOULD carry
   `schema: "<doctype>/vN"`; that's a change in `createDoctype`'s
   default `build()`, cheap and backwards-compatible.
2. **Registry key divergence.** Packs key on `name`, everything else on
   `id`/`slug` — a default-keyed `createRegistry({family:"pack"})`
   still throws (**[driven]**). `RefCatalog` must own the family table
   (`aip → family + keyBy`), and AIP-52 would ideally gain `id` (or the
   registry default gains `name`) rather than every host re-passing
   `keyBy`.
3. **AIP-52's legacy `pricing` block** still drifts from capability
   pricing (unitless `bundle: 49`). The capability is declared
   authoritative; a deprecation path for `pack.pricing` should be part
   of the AIP-55 adoption, not silently left.
4. **Extension `tighten` verification is still best-effort**
   (`spec-from-extension.ts:144-148` — the parent's raw schema isn't
   exposed for real monotonicity checks). Selective composition doesn't
   fix that; it adds `remove_fields` needing the same introspection.

## 5. AIP-55 becomes a consumer, not a primitive

Under this foundation the AIP-55 draft collapses from "a product
doctype with a bespoke target union" to:

- the **pricing capability payload** (price union + billingRail +
  Stripe/Autumn rail configs — all the commerce thought in the AIP-55
  draft carries over verbatim), and
- `on: ArtifactRef` replacing the entire `target` oneOf.

**This is architecture-only, not a complete field-by-field refactor of
the AIP-55 draft.** The `target` oneOf (`kind`/`appRef`/`packRef`/
knowledge-pack string) is the only part this proposal claims to replace,
because it's the only part duplicating the reference problem solved in
§1. AIP-55's other fields carry over into `CapabilityDefinition` as
follows, and the mapping is deliberately conservative — no field is
dropped:

| AIP-55 draft field | Status under this proposal |
|---|---|
| `target` (oneOf `appRef`/`packRef`/pack string + `version`) | **replaced** by `on: ArtifactRef` (§1); the `version` sub-field moves onto `ArtifactRef.version`, unchanged in meaning |
| `price` / `billingRail` | **unchanged**, becomes `CapabilityDefinition.payload` verbatim (already stated above) |
| `id` (product id) | **unchanged**, becomes `CapabilityDefinition.id` (already required by the generic capability shape in §2) |
| `title` (optional, human label) | **deferred, not dropped**: stays an optional field on the product/pricing capability, i.e. `CapabilityDefinition` gains an optional `title?: string` when AIP-55 is implemented as a capability kind. It has no interaction with `on`/`ArtifactRef` and needs no design beyond "pass it through" |
| `metadata` (optional, free-form) | **deferred, not dropped**: same as `title` — carries through as an optional passthrough field on the capability (or inside `payload`, at the implementer's discretion), since `kind: "pricing"` payloads are already typed per-kind and can absorb it without a schema for the generic `CapabilityDefinition` |

`title` and `metadata` are intentionally not designed further here: they
don't touch the reference/attachment architecture this note is about,
and speculative schema for them now would be guessing ahead of AIP-55's
actual implementation. Concretely, this proposal defines the
reference (§1) and capability-attachment (§2) architecture; **the full
AIP-55-as-capability field mapping, including where `title`/`metadata`
finally live, is implementation work for AIP-55 itself**, not settled
here.

The per-kind `appRef`/`packRef` fields are deleted. The worked example
in `specs/resources/aip-55/draft/PRODUCT.md` keeps its Agentik examples
(book1/coder pay-per-call, book3/SEO prepaid pool, default one-time);
their manifests change only in the target stanza (fields outside
`target` — `id`, `price`, `billingRail`, and optional `title`/
`metadata` — are unaffected and omitted here for brevity):

```yaml
# before (AIP-55 draft)         # after (this proposal)
target:                         on: aip://42/book-companion@1.2.0
  kind: app
  appRef: book-companion
  version: 1.2.0
```

Numbering suggestion (not authority): the reference primitive takes
**AIP-54**; capability attachment can either extend AIP-55 in place
(pricing is just the first `kind`) or its own AIP-55 — extending 53 is
cheaper and keeps "product" as the named consumer concept.

## 6. What this buys, in Jeremy's sentence

"**Sandbox has a price**" — `attachPricing(refFor(sandboxSpec, sbx),
…)`; sandbox AIP unchanged. **[driven]**

"**Tool has a price**" — same call, real AIP-14 `toolSpec`. **[driven]**

"**Agent has a price**" — same call; AIP-42 handles need the `schema`
convention fix (§4.1), which is the one real change the reference
primitive asks of existing packages.

"**A collection of those, of anything, with proper typing**" — one
`CapabilityHandle[]` filtered by `on.aip`; AIP-18 collections get there
by upgrading `ref` fields to `ref/v1` URIs rather than gaining their own
money type.

"**Controllable inheritance**" — AIP-40 v2's `remove_fields` +
`inherit` per-aspect selection, guarded, back-compatible. **[driven]**
