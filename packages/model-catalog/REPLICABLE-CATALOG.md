# Replicable model catalog — plan

Two goals, from the maintainer:

1. **Catalog data should be resolved/generated, not hand-committed.** Prices,
   model lists, and voices should come from provider sources via a generator
   that runs in CI — reproducible, reviewable diffs, no hand-maintenance.
2. **Consumers can add aliases / entries without forking the core.** App-specific
   bits (Simone's legacy `simone-N` voice slugs, a `simone-infographic`
   fine-tune, Katchy image styles) live as a **consumer overlay**, never in the
   OSS data.

## Architecture

```
provider APIs ──(generator, pinned source)──▶ *.generated.ts   ← canonical, replicable, OSS core
                                                     │
                                          registerCatalogOverlay(appOverlay)   ← app-side aliases / extra entries
                                                     ▼
                                          getModel / listModels / resolveAlias
```

- **Generated, provider-native data** is the only thing in the OSS core. Canonical
  ids come from the provider (e.g. an ElevenLabs voice's id), never a human pick.
- **Overlay** = a runtime registration a consumer makes once at boot. It can add
  alias→canonical mappings and extra/override entries per kind. The registry
  consults overlays first, then the base catalogs.

## Phases

- **P1 — Overlay API (this PR).** `overlay.ts`: `registerCatalogOverlay`,
  `clearCatalogOverlays`, `CatalogOverlay`. `getModel`/`resolveAlias`/`listModels`
  consult it. Tested.
- **P2 — De-brand via overlay (this PR).** Strip `simone-N` aliases + the
  `simone-infographic` entry from core data; ship them as `overlays/simone.ts`
  (an example consumer overlay). Fix stale `@agstudio/*` doc comments.
- **P3 — Generator framework.** A `catalog-sync` entry per provider/modality that
  fetches a **pinned** provider source → emits `*.generated.ts`. Start with the
  LLM generator (openrouter / models.dev — the pattern already exists), then
  voice (elevenlabs/minimax/openai/gemini), then image/video (replicate/flux).
- **P4 — CI workflow.** `.github/workflows/catalog-sync.yml` runs the generators
  on a schedule + on demand, opens a PR with the diff (mirrors the changesets
  release flow). That is the "CI that builds the catalog."

## Invariants

- The OSS core ships **no product names** (`simone`, `katchy`, …) in data.
- Generated files are deterministic from their pinned source — re-running with
  the same snapshot yields no diff.
- Overlays are additive: a consumer never edits core files to add an alias.
