# Model Catalog Watch

A built-in agentproto app on top of `scripts/catalog-sync/run-all.mjs` and
the `catalog_diff` MCP tool (`@agentproto/runtime`, backed by `diffCatalog`
in `@agentproto/model-intel`). Ships as a hand-authored bundled app
(`.agentproto/APP.md` + `workflows/`) like `repo-maintenance` and
`session-steward`.

## What it does

The `watch` workflow, one run:

1. `sync` — re-runs the manual LLM pricing catalog sync
   (`scripts/catalog-sync/run-all.mjs`).
2. `diff` — `catalog_diff` diffs the freshly-synced catalog against the
   baseline stored from the previous run and records "now" as the new one.
3. `gate` — a placeholder (`command: "true"`, always passes). Nothing
   downstream exists yet to decide "should this trigger a bench?" — see
   `.agentproto/workflows/watch/WORKFLOW.md` for the full scope notes.
4. `digest` — a free-tier `opencode`/`mimo-v2.6-flash-free` session writes a
   short digest of what changed, strictly from the structured diff.

See `.agentproto/workflows/watch/WORKFLOW.md` for the step-by-step doc and
documented limitations (no real event dispatch yet, no live go/zen probing,
no promo detection, no bench trigger), and `routines/` for the daily
scheduled template.

## Enabling

See `routines/model-catalog-watch-daily/ROUTINE.md`'s own "Enabling" section.
