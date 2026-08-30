# @agentproto/catalog-sync

Build-time generator framework for [`@agentproto/model-catalog`](../model-catalog).
Catalog data (prices, model lists) is **generated** from pinned provider
sources, not hand-committed — every `*.generated.ts` is reproducible from a
committed snapshot, and CI catches drift via `--check`.

## Contract

```ts
// src/types.ts — FROZEN
interface CatalogSource { id: string; url: string }
interface GeneratorContext {
  fetchSource(src: CatalogSource): Promise<unknown>  // snapshot-first; refresh fetches + writes
  refresh: boolean
}
type GeneratedFiles = Record<string, string>  // repo-relative path → TS source text
interface CatalogGenerator {
  name: string                 // "llm:openrouter"
  modality: "llm" | "image" | "video" | "audio" | "voice"
  sources: CatalogSource[]
  generate(ctx: GeneratorContext): Promise<GeneratedFiles>
}
function defineGenerator(g: CatalogGenerator): CatalogGenerator
```

A sibling agent builds provider generators against this surface. Adding new
generators is the extension path; editing `types.ts` is not.

## Flow

```
provider API ──(generate --refresh)──▶ snapshots/<id>.json   ← committed, deterministic
                                              │
                            generate (offline) ▼
                                          *.generated.ts   ← drop-in for model-catalog
```

- **Offline by default.** `generate` reads `snapshots/<id>.json`. Tests and CI
  never hit the network.
- **Network only behind `--refresh`**, which fetches each source's pinned URL
  and writes the snapshot for the next offline run.

## CLI

```
pnpm --filter @agentproto/catalog-sync generate          # write changed files
pnpm --filter @agentproto/catalog-sync generate --check  # diff vs committed; exit 1 on drift (CI)
pnpm --filter @agentproto/catalog-sync generate --refresh  # re-fetch pinned sources
```

## `addedAt` convention

Some generators (currently `llm:openrouter` and `llm:requesty` — the two
producing `LLMPricing` entries) stamp an `addedAt?: string` field (ISO
`YYYY-MM-DD`) on each catalog entry: the date that model id was first seen
by a sync run.

- **Backfill rule.** When the provider source itself carries a creation
  timestamp for the id (OpenRouter's and Requesty's `/v1/models` both carry
  a Unix-seconds `created` field), a brand-new id is backfilled with that
  date, converted to `YYYY-MM-DD`. When the source has no such field, the
  id is stamped with the sync run's own date instead.
- **Never-mutated invariant.** Once an id has an `addedAt` stamp, it is
  never overwritten by a later run — not even if the source's own `created`
  value for that id later resolves to something different. A model id
  disappearing and later reappearing keeps its ORIGINAL stamp rather than
  looking newly added.
- **Mechanism: a per-generator ledger file**, committed at
  `packages/catalog-sync/ledger/<generator-id>.json` (e.g.
  `ledger/llm-openrouter.json`) — a flat `{ "model/id": "YYYY-MM-DD", ... }`
  map, sorted keys, deterministic serialization. Each generator reads its
  own ledger directly off disk (a plain `node:fs` read — `GeneratorContext`
  intentionally has no general repo-read capability; the ledger is a
  generator-internal concern, not part of the frozen `types.ts` contract),
  merges in the current run's ids via `computeAddedAtLedger` (see
  `src/added-at.ts`), and returns the updated ledger as a second entry in
  its `GeneratedFiles` — so `runner.ts`'s existing diff/write logic (and
  `--check`'s drift detection) covers the ledger file for free, same as any
  other generated file.
- Ledger entries are **never dropped**, even for ids no longer present in a
  run — the ledger records "first ever seen", not "currently present".

See `src/added-at.ts` for the implementation and `src/generators/llm-openrouter.ts` /
`src/generators/llm-requesty.ts` for how a generator wires it in.

## `CATALOG-CHANGELOG.md`

`packages/model-catalog/CATALOG-CHANGELOG.md` is a human-readable "what
models changed" log — NOT the changesets-driven `CHANGELOG.md` next to it
(that one is package-version history, one entry per publish). It answers
"what did catalog-sync add or remove, and when" by reading top to bottom.

- **Written automatically** by `runGenerators` (`src/runner.ts`), not by
  hand. After collecting every generator's output, the runner diffs each
  changed `*.generated.ts` file's top-level id keys (before vs after —
  see `src/changelog.ts`'s `extractRecordIds` / `diffModelIds`) and, when at
  least one generator actually added or removed a model id, appends one
  dated section:

  ```
  ## 2026-08-31

  ### llm:requesty
  - Added: alibaba/qwen3.8-flash, alibaba/qwen3.8-max, ...
  - Removed: anthropic/claude-opus-4-1, ...
  ```

- **Sections are appended at the END of the file (newest last)** — a plain,
  non-destructive `+=`. This is a deliberate choice over "newest first";
  it means the writer never has to parse and re-emit prior history, only
  concatenate.
- **A run with no id-level drift emits nothing** — no empty section, no
  touched file, no diff. Pricing-only changes (a model's price moved but no
  id was added/removed) are NOT logged here; they're visible in the
  generated file's own git history.
- addedAt ledger files (`ledger/*.json`) are deliberately excluded from this
  diff — they never lose an id (see above), so they carry no "removed"
  signal, and every "added" id they'd report is already covered by the
  owning generator's own `*.generated.ts` diff.

## Generators

### `llm:openrouter`

Source: `https://openrouter.ai/api/v1/models` (pinned snapshot:
`snapshots/llm-openrouter.json`). Emits
`packages/model-catalog/src/llm/openrouter-routes.generated.ts` — a drop-in
`OPENROUTER_ROUTES: Record<string, LLMPricing>` plus the derived
`OPENROUTER_PROVIDERS` list.

- Per-token USD prices → `inputPer1M` / `outputPer1M` (USD per 1M tokens).
- `cache_read` / `cache_write` (when present) → `cacheReadMultiplier` /
  `cacheWriteMultiplier` (ratio vs base input). The committed model-catalog
  file omits these; this generator emits them when the source carries them
  (P3 spec: "plus cache fields if the source has them") — additive and
  `LLMPricing`-compatible.
- Unpriced routes (`openrouter/auto`) are skipped.
- `addedAt` (ISO date, first-seen, never mutated) is stamped per id via the
  `ledger/llm-openrouter.json` ledger — see "`addedAt` convention" above.

### `llm:requesty`

Source: `https://router.requesty.ai/v1/models` (pinned snapshot:
`snapshots/llm-requesty.json`). Emits
`packages/model-catalog/src/llm/requesty-routes.generated.ts` — a drop-in
`REQUESTY_ROUTES: Record<string, LLMPricing>` plus the derived
`REQUESTY_PROVIDERS` list.

- Per-token USD prices (JSON numbers) → `inputPer1M` / `outputPer1M`.
- `cached_price` is emitted as `cacheReadMultiplier` only when the source also
  marks `supports_caching: true`; Requesty has no cache-write price, so
  `cacheWriteMultiplier` is never emitted.
- Live refresh requires `REQUESTY_API_KEY` to be set; without it the generator
  reuses the committed snapshot.
- `addedAt` (ISO date, first-seen, never mutated) is stamped per id via the
  `ledger/llm-requesty.json` ledger — see "`addedAt` convention" above.

### `llm:context-windows`

Sources: Anthropic, Groq, xAI, and Moonshot models-list endpoints (pinned
snapshots: `snapshots/llm-anthropic.json`, `snapshots/llm-groq.json`,
`snapshots/llm-xai.json`, `snapshots/llm-moonshot.json`). Emits
`packages/model-catalog/src/llm/context-windows.generated.ts` — a drop-in
`CONTEXT_WINDOWS: Record<string, ContextWindowEntry>`.

- `contextWindow` maps to each provider's max-input/context-length field.
- `maxOutput` is captured when the source publishes one.
- This is **not pricing**; billing data still comes from `llm:openrouter` and
  hand-maintained pricing entries in `model-catalog`.
- OpenAI and ZAI/Zhipu are excluded because they don't publish a stable,
  machine-readable context-window list.
