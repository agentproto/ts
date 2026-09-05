# @agentproto/app-config

Layered YAML config kit for agentproto apps — the app-agnostic core that
`@agstudio/book-config` (collection.yaml → order entry → book.yaml) sits on.
`defineAppConfig({ app, item, itemsKey, defaultsKey })` returns a typed kit
that loads, validates, schemas, contracts, gates, and verifies an app's
layered YAML configuration.

## Quick start

```ts
// app.config.ts
import { z } from "zod"
import { defineAppConfig } from "@agentproto/app-config"

export const kit = defineAppConfig({
  app: z.object({
    id: z.string(),
    items: z.array(z.looseObject({ id: z.string() })).default([]), // entries may carry overrides
    defaults: z.object({ lang: z.string().default("en") }).default({ lang: "en" }),
  }),
  item: z.object({
    id: z.string(), // REQUIRED on every item file
    title: z.string(),
    lang: z.string().default("en"),
  }),
  itemsKey: "items",
  defaultsKey: "defaults",
})

export const template = (item) => ({ id: item.id, title: item.value.title })
```

```yaml
# config/app.yaml
id: doc-app
defaults:
  lang: en
items:
  - id: guide          # entry: position in the run order + per-item overrides
```

```yaml
# config/items/guide.yaml
id: guide
title: The Guide
```

## Precedence

`load(rootDir)` merges, lowest → highest (the same chain book-config
resolves):

1. **app-level defaults** — `app.yaml` under `defaultsKey` (a nested dot
   path like `presets.default` works; an array leaf, e.g.
   `knowledge.defaults`, mounts under its parent segment so
   `mergeArraysBy` can key it)
2. **the app `items[]` entry** matched against the item (see
   `matchKey` below; default `entry.id === item.id`) — run-order position
   plus per-item overrides
3. **the item file** — wins on conflict (a file that narrows its slice must
   not inherit the app-wide default)

Merge is deterministic: objects deep-merge key-by-key, arrays REPLACE
(order is meaningful configuration, not something to interleave). Two
escape hatches: `mergeArraysBy` (keyed-array merge —
`{ knowledge: "workspace" }` makes overlay entries with the same
`workspace` key REPLACE the base entry in place, others append) and
`project` (a hook over the merged raw value before the item schema parses
it, for per-field projections like `accent: book.cover?.accent ??
collection.cover.accents[book.vertical]`). Merge layers read from the raw
YAML so schema-stripped keys still merge; validation runs through both
schemas. `precedence` accepts a permutation of
`["defaults", "entry", "item"]` if an app wants the opposite conflict
resolution.

`load` returns `{ rootDir, appFile, app, items: Map<id, ResolvedItem>, order }`
— `order` lists entry-matched items first (entry order), then file-only
items by filename. Every `ResolvedItem` carries `itemPath` (absolute) and
`dir` (the directory containing it). An item file without a non-empty
string `id` is keyed by its per-item directory name (`manuscripts/<dir>/book.yaml`
→ `book3-le-seo-augmente`) or, for a flat glob, its file basename.

## Kit surface

- **`load(rootDir, { appFile?, itemsGlob? })`** — defaults
  `config/app.yaml` and `config/items/*.yaml`. Globs support a flat
  directory, a leading doublestar segment (recursive), a fixed basename
  inside per-item directories (`manuscripts/*/book.yaml`), and wildcard
  directory segments (`groups/team-*/item.yaml`). Throws
  `AppConfigError` / zod errors.
- **`jsonSchemas()` / `writeSchemas(dir)`** — JSON Schemas emitted with
  `io: "input"`, so defaulted fields are NOT `required`.
- **`contracts({ resolved, template, dir })`** — `template(item)` renders
  each item; `write()` emits `contracts/<id>.contract.json` (sorted keys,
  deterministic bytes); `check()` diffs the sha256 of the canonical JSON
  against disk and returns `{ id, file, reason: "missing" | "drifted" }[]`.
- **`gates(resolved, rules)`** (async) — declarative rules
  `{ id, level: "error" | "warn", test: (ctx) => Finding[] | Promise<Finding[]> }`
  where `ctx = { resolved, item?, readArtifact(relPath): Promise<string>, contract? }`;
  `readArtifact` resolves relative to `resolved.rootDir` and rejects on
  path escape or missing file. `ok` is false only on error-level findings.
- **`verify(resolved, { rules?, template?, contractsDir?, scopes? })`**
  (async) — composes gates + `contracts.check` + caller scope functions
  into one `{ ok, findings, summary: { errors, warnings, skipped } }`;
  findings are `{ scope, level: "error" | "warn" | "skipped", message,
  item?, attrs? }` — `attrs` is free-form (`{ book, chapter }`), the shape
  an app's `verify.command` reports.

## Consumer with a non-`id` data model

The kit is not tied to `id`-keyed items. `@agstudio/book-config`'s real
model: a `collection.yaml` whose `order` entries are `{n, slug, tier}`,
matched against each `manuscripts/<book>/book.yaml` by the `n` field;
series knowledge defaults merge keyed by `workspace`; the cover accent
falls back to the collection's per-vertical accent map:

```ts
import { z } from "zod"
import { defineAppConfig, type AppKit } from "@agentproto/app-config"

const CollectionSchema = z.object({
  id: z.string(),
  cover: z.object({ accents: z.record(z.string(), z.string()) }).default({ accents: {} }),
  knowledge: z.object({ defaults: z.array(KnowledgeSelector).default([]) }).default(...),
  order: z.array(z.object({ n: z.number().int(), slug: z.string(), tier: z.string() })).default([]),
})

const BookSchema = z.object({
  n: z.number().int(),
  slug: z.string(),
  vertical: z.string(),
  accent: z.string().optional(),
  lang: z.string().default("en"),
  knowledge: z.array(KnowledgeSelector).default([]),
})

export const kit: AppKit<typeof CollectionSchema, typeof BookSchema> = defineAppConfig({
  app: CollectionSchema,
  item: BookSchema,          // no `id` — items are keyed by their directory
  itemsKey: "order",         // the ordered entries are `order[]`
  defaultsKey: "knowledge.defaults", // nested path; array leaf mounts under "knowledge"
  matchKey: { entry: "n", item: "n" },
  mergeArraysBy: { knowledge: "workspace" }, // keyed merge, not replace
  project: (merged, ctx) => ({
    ...merged,
    accent: merged["accent"] ?? ctx.app.cover.accents[String(merged["vertical"])],
  }),
})

// manuscripts/book3-le-seo-augmente/book.yaml → resolved.items.get("book3-le-seo-augmente")
const resolved = kit.load(contentFactoryRoot, {
  appFile: "collection.yaml",
  itemsGlob: "manuscripts/*/book.yaml",
})
```

Scopes and gate rules are generic over the app's own resolved type, so an
app registers them over `Resolved<Collection, Book>` instead of the loose
default:

```ts
type ResolvedBooks = Resolved<z.output<typeof CollectionSchema>, z.output<typeof BookSchema>>

const scopes: Record<string, ScopeFn<ResolvedBooks>> = {
  accents: (r) => /* r.items.get(id)?.value.accent is a string | undefined */,
}
const rules: GateRule<ResolvedBooks>[] = [
  {
    id: "line-width",
    level: "error",
    test: async (ctx) => {
      const md = await ctx.readArtifact(`output/${ctx.resolved.order[0]}/chapter.md`)
      return md.split("\n").filter((l) => l.length > 100).map((_, i) => ({
        message: `line too long`, item: "book3", attrs: { book: "book3", chapter: String(i) },
      }))
    },
  },
]
```

## CLI

```sh
node --experimental-strip-types node_modules/.bin/app-config check app.config.ts
node --experimental-strip-types node_modules/.bin/app-config schema app.config.ts
node --experimental-strip-types node_modules/.bin/app-config contracts [--check] app.config.ts
node --experimental-strip-types node_modules/.bin/app-config verify app.config.ts
```

The config module exports `kit` plus optional `rules`, `template`,
`contractsDir`, and `scopes`. An app's AIP `verify.command` can simply be
`node scripts/verify.mjs` calling `runCli` from `@agentproto/app-config/cli`.

## CLI smoke test

```sh
pnpm --filter @agentproto/app-config test   # 30 tests: precedence, schemas, contracts drift, gates (readArtifact/attrs), verify, CLI, consumer-zod fixture
```

## zod as a peer dependency

zod is a **peerDependency** (`^4`) — the kit compiles its types against
whatever zod copy the consumer installs, so a consumer's `ZodObject`
instances type-check against `defineAppConfig`'s generics (the
`test-fixtures/consumer/` fixture pins this with its own zod copy and a
`tsc --noEmit` contract test).
