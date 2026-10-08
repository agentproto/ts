---
"@agentproto/catalog-sync": minor
"@agentproto/model-catalog": patch
---

Anthropic and Kimi prices now come from the vendor's own pricing page, not OpenRouter. `sync-anthropic.mjs` reads `platform.claude.com/docs/en/about-claude/pricing.md` and `sync-moonshot.mjs` reads `platform.kimi.ai/docs/pricing/chat.md`. Neither needs an API key. OpenRouter stays as the per-row fallback for ids the page doesn't list, and as the whole-file fallback if the page can't be used. OpenRouter's `moonshotai/*` price is the rate of whichever host it routes to: on 2026-10-08 it had kimi-k3 at $0.62 / $12.30 against Moonshot's $3.00 / $15.00. Every row now records `priceSource` (`"anthropic"`, `"moonshot"` or `"openrouter"`). `sync-moonshot.mjs` takes its id list from the committed `llm-moonshot.json` snapshot when there is no key, which adds `kimi-k2.7-code-highspeed`. The parsers are `src/sources/anthropic-pricing-page.mjs` and `src/sources/kimi-pricing-page.mjs`. The regenerated Anthropic and Moonshot pricing files are included.
