---
"@agentproto/catalog-sync": minor
"@agentproto/model-catalog": patch
---

Anthropic and Kimi prices now come from the vendor's own pricing page, not OpenRouter. `sync-anthropic.mjs` reads `platform.claude.com/docs/en/about-claude/pricing.md` and `sync-moonshot.mjs` reads `platform.kimi.ai/docs/pricing/chat.md`. Neither needs an API key. OpenRouter stays as the per-row fallback for ids the page doesn't list, and as the whole-file fallback if the page can't be used. OpenRouter's `moonshotai/*` price is the rate of whichever host it routes to: on 2026-10-08 it had kimi-k3 at $0.62 / $12.30 against Moonshot's $3.00 / $15.00. Every row now records `priceSource` (`"anthropic"`, `"moonshot"` or `"openrouter"`). `sync-moonshot.mjs` takes its id list from the committed `llm-moonshot.json` snapshot when there is no key, which adds `kimi-k2.7-code-highspeed`. The parsers are `src/sources/anthropic-pricing-page.mjs` and `src/sources/kimi-pricing-page.mjs`. The regenerated Anthropic and Moonshot pricing files are included.

MiniMax gets the same treatment. `sync-minimax.mjs` reads `platform.minimax.io/docs/guides/pricing-paygo.md` for prices, cache-write prices and the MiniMax-M3 >512k tier, plus model ids. It skips the opt-in Priority tab and bills the sale price where the page also shows a struck list price. This adds MiniMax-M3 and the `-highspeed` variants, and corrects MiniMax-M2.7 ($0.21 / $0.84 → $0.30 / $1.20) and M2.5. M2-her isn't on the page, so it stays on OpenRouter. Mistral is unchanged: its OpenRouter prices match Mistral's own page on every row we carry.

