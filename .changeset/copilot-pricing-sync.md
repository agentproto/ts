---
"@agentproto/model-catalog": minor
"@agentproto/catalog-sync": patch
"@agentproto/cli": patch
---

Price the models the `copilot-cli` harness runs from GitHub Copilot's own price list, synced automatically like the other vendors. New `scripts/catalog-sync/sync-copilot.mjs` (picked up by the weekly `run-all.mjs`) reads `data/tables/copilot/models-and-pricing.yml` and the promo footnotes of `models-and-pricing.md` in github/docs and writes `copilot-pricing.generated.ts`: `mai-code-2`, `mai-code-2-flash`, `mai-code-1.1-flash` and the dotted ids (`claude-sonnet-5.5`, `claude-haiku-5.5`, ...) that no native vendor sync spells that way. Native generators still win on any id they also price. Rows carry `priceSource: "github-copilot"`, cache-read/write ratios and prompt-length tiers. New optional `LLMPricing.promo` (`until` + `then`) and `effectivePricing()`: a dated promo (MAI Code 2: $0.50/$2.50 until 2027-05-17, $1/$5 from that day) resolves to its standard price on its own, in `resolvePricing*` and `agentproto models`. If the source is unreachable or its layout changes, the sync keeps the committed file and exits 2 with the reason.

`agentproto models`: a model with no price now prints `price n/a: <reason>` (and `priceNote` in `--json`) instead of a blank; `copilot-cli` models are `runnable` when the adapter is ready (its own login), not "unavailable" for lack of a provider key.
