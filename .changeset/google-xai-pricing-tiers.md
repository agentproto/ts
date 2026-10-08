---
"@agentproto/catalog-sync": patch
"@agentproto/model-catalog": patch
---

Native Google and xAI pricing now carries prompt-length tiers. `sync-google.mjs` emits `tiers` from OpenRouter's `min_prompt_tokens` overrides, so Gemini Pro prompts over 200k tokens bill at the higher rate. `sync-xai.mjs` turns xAI's native long-context prices into `tiers` and its cached-input price into `cacheReadMultiplier`. Both were captured before but never billed, so xAI cache hits were charged at the full input rate. The row conversion lives in the new `src/sources/xai-pricing.mjs`.

`sync-xai.mjs` now falls back to the committed `snapshots/llm-xai.json` when `XAI_API_KEY` is missing or the xAI API call fails, the same way `sync-anthropic.mjs` does. The xAI key has been answering 403 (out of credits), which failed the native sync every week and froze xAI pricing. The regenerated `xai-pricing.generated.ts` and `google-pricing.generated.ts` are included: same prices in the billed shape, plus `grok-4.7` from the pinned snapshot.
