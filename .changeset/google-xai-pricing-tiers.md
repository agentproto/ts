---
"@agentproto/catalog-sync": patch
---

Native Google and xAI pricing now carries prompt-length tiers. `sync-google.mjs` emits `tiers` from OpenRouter's `min_prompt_tokens` overrides, so Gemini Pro prompts over 200k tokens bill at the higher rate. `sync-xai.mjs` turns xAI's native long-context prices into `tiers` and its cached-input price into `cacheReadMultiplier`. Both were captured before but never billed, so xAI cache hits were charged at the full input rate. The row conversion lives in the new `src/sources/xai-pricing.mjs`.
