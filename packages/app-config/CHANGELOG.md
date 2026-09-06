# @agentproto/app-config

## 0.3.0

### Minor Changes

- ccb72ff: `jsonSchemas(opts?)` accepts a consumer-supplied `toJSONSchema` conversion. By default the kit still converts with its own zod copy, but a consumer pinned to a different zod minor can now delegate the emit, so committed JSON Schemas regenerate identically (e.g. nullable fields emit the consumer zod's `anyOf` form instead of the kit zod's `type: ["string","null"]`).
- 92ab457: Injectable I/O source port (`ConfigSource`) — every filesystem call site in the kit
  (app/item file reads, the items-glob directory walks, contract read/write, schema
  emit) now routes through a source you can swap. Defaults to the real filesystem, so
  nothing changes when you don't pass one. Inject at `defineAppConfig({ source })` or
  per call on `load(root, { source })` (per call wins), and ship your config entirely
  from memory with the new `memorySource(files, root)` — an already-parsed or
  synthetic collection no longer needs a second resolution path. Gate rules and scope
  functions get the same guarded port on their context (`ctx.source`): `readFile`,
  `listDir`, and `probe` (file / dir / missing) relative to the resolved root, with
  the same `..`-escape `AppConfigError` guard as `readArtifact` — so a rule can list
  directories and treat "missing" as a finding instead of an error. `ResolvedItem`
  also now carries the matched raw `items[]` entry (`entry`, null for file-only
  items), so consumers no longer recover it through `entryIndex`.
- 2b06483: v0.3: consumer-portable schema surface, shipped declarations, richer verify.
  - **Zod-version-portable generics.** `defineAppConfig` / `AppKitDefinition` /
    `AppKit` no longer constrain on `z.ZodObject<z.ZodRawShape>` (which leaked
    zod internals like `$ZodType`/`exactPartial` and rejected consumers whose
    zod minor differed from the kit's). They now constrain on the kit-owned
    structural `SchemaLike<Out>` (`{ parse(value: unknown): Out }`), and
    `AppKit<AOut, IOut>` is parameterized by the schemas' **output** types.
    A consumer pinning zod 4.4.3 compiles against a kit tree on 4.5.4 with no
    cast and no pin bump (proved by the `test-fixtures/consumer` fixture).
  - **Declarations ship.** `pnpm build` emits `dist/*.d.ts`, so importing the
    kit gives types without running a second build step.
  - **Richer scopes and gates.** `ScopeFn` may be async and receives a
    `ScopeContext` with `readArtifact` (same rootDir-escape guard as gate
    rules), so one umbrella scope can read artifacts while emitting
    error/warn/skipped findings at per-finding levels; sync single-argument
    scopes keep working. Gate findings may carry their own `level`, overriding
    the rule's per finding.
  - **`project()` output survives.** The projected object is exposed verbatim
    on `ResolvedItem.projected` (pre-parse), so derived fields the item schema
    does not declare are no longer stripped by `item.parse`.

## 0.2.0

### Minor Changes

- 8077e5f: New package `@agentproto/app-config` — layered YAML config kit for agentproto apps, generalized from @agstudio/book-config. `defineAppConfig({ app, item, itemsKey, defaultsKey })` returns a typed kit: `load()` merges app-level defaults → app `items[]` entry → item file (deep for objects, arrays replace), emits input-io JSON Schemas (defaulted fields not required), generates per-item contract files with canonical-JSON sha256 drift check, runs declarative config gates, and composes gates + contracts + caller scopes into one verify report — plus a minimal CLI (`check | schema | contracts [--check] | verify`) over an `app.config.ts` kit instance so an app's `verify.command` can call the kit.
- 41040fa: Fit the kit to its first real consumer (a book-shaped data model): zod is now a peerDependency so a consumer's own zod copy type-checks against the kit generics (fixture contract test under `test-fixtures/consumer/`); `matchKey` matches entries by a field pair (`{ entry: "n", item: "n" }`) or predicate instead of requiring `id`; `defaultsKey` accepts a nested dot path (`"presets.default"`, with an array leaf mounting under its parent segment); `mergeArraysBy` does keyed-array merge (same-key entries replace in place, others append) beside the replace default; a `project(merged, ctx)` hook enables per-field projections (e.g. `accent ?? accents[vertical]`); `itemsGlob` accepts a fixed basename inside per-item dirs (`manuscripts/*/book.yaml`) and wildcard directory segments, and every resolved item exposes its `dir`; `VerifyFinding`/gate findings gain `attrs`; `GateRule<R>` / `ScopeFn<R>` / `VerifyInput<R>` are generic over the app's resolved type, and `gates`/`verify` are now async with a `GateContext` carrying `readArtifact(relPath)` for per-item artifact rules.
