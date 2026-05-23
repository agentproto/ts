# Versioning policy

How `@agentproto/*` packages version themselves, their on-disk
schemas, and the cross-package contracts that connect them.

## Three independent version axes

A typical agentproto package carries three versions that move on
different cadences:

1. **npm semver** — the published package version (`0.1.0-alpha.0`).
   Tracks code shipped to npm. Follows semver: major for breaking
   public-API changes, minor for additions, patch for fixes.
2. **Schema version** — the on-disk format the package emits/reads
   (`knowledge.entry/v1`, `agentruntimes/v1`, `agentcompanies/v1`).
   Tracks the *data contract*. Changes only when the data shape
   changes in ways readers must care about.
3. **Spec / AIP version** — the upstream AIP this package implements
   (AIP-10, AIP-12, …). Tracks the *normative document*. Changes when
   the spec itself amends.

These are deliberately decoupled. A bug-fix release bumps npm but
leaves the schema untouched; a schema migration may bump from v1 → v2
across many package releases.

## Schema versioning

### Naming

Schema discriminators follow the pattern `<doctype>/<vmajor>`:

```
knowledge.entry/v1
knowledge.source/v1
knowledge.workspace/v1
playbooks/v1
agentcompanies/v1
agentruntimes/v1
agentproto/runtime-profile/v1
agentproto/plugin/v1
```

Only the major version is exposed in the discriminator. Minor changes
that don't require reader updates (additive optional fields, looser
constraints) ride inside the same vN.

### Compatibility rules

Within a major version, schemas are **forward-compatible**:

- **Adding optional fields is safe.** Readers MUST ignore unknown
  keys. Authors MAY use them; old readers won't see them.
- **Loosening a constraint is safe.** A field that was required can
  become optional; a string regex can widen; a max can grow.
- **Tightening a constraint is breaking.** Making an optional field
  required, narrowing a regex, lowering a max — these need a major bump.
- **Renaming or removing a field is breaking.** No exceptions; use an
  alias-and-deprecate cycle if you must.

In short: readers tolerate unknown keys; authors don't redefine known
keys. This matches the AIP convention of stashing host-specific
extensions under `metadata.<vendor>.*`.

### When v1 → v2 is needed

A major bump is warranted when:

- A required field is renamed or removed
- The discriminator itself changes (e.g. `knowledge.entry/v1` →
  something fundamentally different)
- Semantics of an existing field change in a way old readers can't
  detect

Bumps are AIP-author decisions, not package-author decisions. Run them
through the AIP amendment process.

### Migration story

When v2 lands:

1. **Both versions are recognised in parallel** by the reader for at
   least one minor release. The discriminated-union schema gets a
   second branch for `*/v2`.
2. **Writers can emit either** during the overlap. The package
   advertises a preferred version via a separate API; consumers can
   read the preference but aren't bound by it.
3. **The package ships a one-shot migration utility** as a CLI
   subcommand or exported function: `convert(v1Doc) → v2Doc`. Pure,
   testable, no I/O.
4. **The v1 reader branch is removed** in a later major-npm-version
   release of the package, with a deprecation notice in the changelog
   no fewer than two minor releases before removal.

There is no "auto-migrate on read" behaviour. A reader that encounters
v1 in a v2-only build SHOULD return a structured error, not silently
upgrade — surprise upgrades break audit trails.

### Worked example

Imagine AIP-10 amends to rename `confidence` → `qualityScore` on
`knowledge.entry`:

```
v1: { schema: "knowledge.entry/v1", slug: "...", confidence: 0.8, ... }
v2: { schema: "knowledge.entry/v2", slug: "...", qualityScore: 0.8, ... }
```

Sequence:

1. AIP-10 amendment lands → @agentproto/knowledge releases minor with
   v1 + v2 schemas + `migrateEntry(v1) → v2`.
2. @agentproto/corpus's reader recognises both; downstream agents are
   told the package now prefers v2 for new writes.
3. Tools that produce entries get a soft deadline (e.g. 90 days) to
   call the migration utility on their content and start writing v2.
4. Next major @agentproto/knowledge release drops v1 reader; v1 files
   start producing structured errors with the migration instruction.

## Cross-package contract versions

Two contracts span packages and need their own version line:

### Plugin manifest (`agentproto/plugin/v1`)

The shape agentproto plugins declare in their `package.json#agentproto`
(or `agentproto.json`). Currently v1: `substrates[]`, `dispatchers[]`,
`executors[]`, `stateStores[]`, each with `kind` + `entry` + `export`
+ optional metadata.

Same forward-compatibility rules. Adding `capabilities` or `configSchema`
to an entry is a v1 addition; renaming `kind` → `id` is a v2 bump.

### Runtime profile (`agentproto/runtime-profile/v1`)

The shape profile packages declare in their `profile.json`. Currently
v1: `slug`, `version`, `name`, `description`, `files[]`.

Adding a new merge `strategy` is v1-additive; redefining `strategy:
overwrite` to mean something different is a v2 bump.

## npm semver

Pre-1.0 packages (everything today) follow these conventions instead
of strict semver:

- `0.x.y-alpha.z` — pre-release, no API stability guarantees.
- `0.x.y` — minor-as-major: API may break between any two `0.x`
  releases, but `0.x.y` → `0.x.y+1` is fix-only.
- `1.0.0` — first stable release. After this point, strict semver
  applies: major for breaking, minor for additions, patch for fixes.

Don't ship a `1.0.0` until at least one major external consumer has
shipped against the package in production. The pre-1.0 phase exists
specifically to absorb API churn without forcing a major bump every
two weeks.

## Where this policy lives

This file is the source of truth for `@agentproto/*` packages in this
repository. Packages MAY link to it from their own README without
restating it. Spec-level versioning (the AIPs themselves) lives in the
`agentproto/specs` repo's own policy doc — this file defers to that
for spec versioning, and codifies only how packages reflect spec
changes in their published artefacts.
