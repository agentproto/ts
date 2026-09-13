# AIP-54 — Ref · Implementer Guide

> **Status:** Draft
> **Schema:** `REF.schema.json`
> **Reference runtime:** `@agentproto/ref`

## What is a Ref?

A Ref is **one typed, cross-AIP reference** — `{aip, id, version?}`,
serialized in string contexts as `aip://<aip>/<id>[@version]`. It is
the general answer to a question every AIP has answered differently:

- AIP-18's `ref` field — an id string scoped to ONE named collection,
  no shape guarantee.
- app-kit's `attach` — a structural `DoctypeHandle` that serializes
  the whole bundle and carries no reliable discriminator.
- AIP-42's `AnyRef` — bare strings, typed only by call-site convention.
- AIP-55's first draft — bespoke `appRef`/`packRef` per target kind.

A Ref IS NOT a handle. It is inert data pointing at one; the AIP-43
registry owns the handle. A Ref IS NOT resolvable by itself —
resolution is the host's `RefCatalog`, which joins per-family AIP-43
registries.

## Reference runtime

```ts
import { RefCatalog, refFor, refToUri, refFromUri } from "@agentproto/ref"

const cat = new RefCatalog()
cat.registerFamily(42, { family: "app", keyBy: h => h.id! }, appRegistry)
cat.registerFamily(52, { family: "pack", keyBy: h => h.name }, packRegistry)

const ref = refFor({ aip: 52, keyBy: h => h.name }, packHandle, "1.0.0")
// { aip: 52, id: "the-agentic-coder", version: "1.0.0" }

const hit = cat.resolveStrict(ref)   // { handle, family } — throws if dangling
const uri = refToUri(ref)            // "aip://52/the-agentic-coder@1.0.0"
```

### Normative rules

1. **keyBy identity.** The `keyBy` passed to `refFor` MUST be the same
   function the family's registry uses. A ref id that drifts from its
   registry key is a HARD authoring error.
2. **Unreferenceable handles.** A handle with no registry key (no
   `id`/`provider`/`slug`/`name`) MUST be refused by `refFor` — the
   pre-AIP-54 world silently produced dangling id strings. Anonymous
   AIP-42 apps (no `id`) are unreferenceable; hosts MUST refuse.
3. **Loud failure.** `resolve` on an unknown aip or id returns
   `undefined` (default) or throws `RefFamilyError` /
   `RefUnresolvableError` (`onUnresolvable: "throw"` / `resolveStrict`).
   A dangling ref MUST never masquerade as a resolution.
4. **Ref is inert.** Frozen at construction; carries no behavior. All
   semantics live in the catalog + registries.
5. **One family per aip.** Re-registering replaces the binding
   (hot-reload parity with AIP-43's `replace`).

### Conventions for referenced handles

- **Handles SHOULD carry `schema: "<doctype>/vN"`.** Several existing
  handles don't (e.g. the in-memory AIP-42 `AppHandle` never carries
  the `schema: "app/v1"` literal that `emit` writes into `APP.md`) —
  until they do, `refFor` requires the family spec to be supplied
  explicitly, and a bare serialized handle cannot self-describe into a
  ref. New doctypes SHOULD include it in `createDoctype`'s default
  `build()`.
- **Family keys are the family's choice.** Most families key on `id`
  (or `provider`/`slug` per AIP-43's default), but packs (AIP-52) key
  on `name`. The `RefCatalog` owns the `aip → family + keyBy` table;
  `refFor` MUST be given the same `keyBy` the family's registry uses.

## Migration notes for existing mechanisms

| Existing | Migration |
|---|---|
| AIP-18 `ref` field + `refKind` | Validate ref values as `aip://` URIs; `refKind` narrows the accepted `aip`(s). |
| app-kit `attach` (DoctypeHandle) | Carry `ArtifactRef`s; the host resolves through its catalog. Fixes the inline-the-whole-bundle flaw. |
| AIP-42 `AnyRef` string form | Unchanged at the string layer; `aip://` URIs are a valid `ref:` value hosts narrow to `ref/v1`. |
| AIP-52 `$resolver` | A URI rendering of the same coordinates. |
| AIP-53 draft `target` union | Replaced by `on: ref/v1` (see AIP-53). |

## What a new AIP needs to be referenceable

Nothing ref-specific. It needs what every AIP needs anyway: a
`defineX` handle with a stable identity field, and (for hosts that
resolve in-memory) an AIP-43 registry entry with a `family` + `keyBy`.
Pricing, entitling, or any future capability composes ON TOP via a
capability attached to a ref — the target AIP never learns about it.
