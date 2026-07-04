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
