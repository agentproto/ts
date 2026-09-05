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

1. **app-level defaults** — `app.yaml` under `defaultsKey`
2. **the app `items[]` entry** whose `id` matches — run-order position plus
   per-item overrides
3. **the item file** — wins on conflict (a file that narrows its slice must
   not inherit the app-wide default)

Merge is deterministic: objects deep-merge key-by-key, arrays REPLACE
(order is meaningful configuration, not something to interleave). Merge
layers read from the raw YAML so schema-stripped keys still merge;
validation runs through both schemas. `precedence` accepts a permutation of
`["defaults", "entry", "item"]` if an app wants the opposite conflict
resolution.

`load` returns `{ rootDir, appFile, app, items: Map<id, ResolvedItem>, order }`
— `order` lists entry-matched items first (entry order), then file-only
items by filename.

## Kit surface

- **`load(rootDir, { appFile?, itemsGlob? })`** — defaults
  `config/app.yaml` and `config/items/*.yaml` (a leading doublestar
  directory segment recurses). Throws `AppConfigError` / zod errors.
- **`jsonSchemas()` / `writeSchemas(dir)`** — JSON Schemas emitted with
  `io: "input"`, so defaulted fields are NOT `required`.
- **`contracts({ resolved, template, dir })`** — `template(item)` renders
  each item; `write()` emits `contracts/<id>.contract.json` (sorted keys,
  deterministic bytes); `check()` diffs the sha256 of the canonical JSON
  against disk and returns `{ id, file, reason: "missing" | "drifted" }[]`.
- **`gates(resolved, rules)`** — declarative rules
  `{ id, level: "error" | "warn", test: (resolved) => Finding[] }`; `ok` is
  false only on error-level findings.
- **`verify(resolved, { rules?, template?, contractsDir?, scopes? })`** —
  composes gates + `contracts.check` + caller scope functions into one
  `{ ok, findings, summary: { errors, warnings, skipped } }`; findings are
  `{ scope, level: "error" | "warn" | "skipped", message, item? }` — the
  shape an app's `verify.command` reports.

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
pnpm --filter @agentproto/app-config test   # 23 tests: precedence, schemas, contracts drift, gates, verify, CLI
```
