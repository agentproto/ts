---
"@agentproto/adapter-claude-sdk": minor
---

Add Moonshot (Kimi) and OpenRouter gateway presets to the claude-sdk adapter.

The `base_url`/`auth_token`/`thinking` options already let a caller front any Anthropic-compatible gateway by hand; this adds two `modes` that pre-wire the endpoint so you only supply the key:

- `mode: moonshot` — sets `ANTHROPIC_BASE_URL` to Moonshot's Anthropic-compatible endpoint, defaults the model to `kimi-k2.7-code`, and enables `--thinking` (Kimi rejects requests without it). One-pick Kimi; supply the Moonshot key via `auth_token`.
- `mode: openrouter` — sets `ANTHROPIC_BASE_URL` to OpenRouter's endpoint; pick a `model` (e.g. `z-ai/glm-5.2`, `deepseek/deepseek-v4-pro`, `moonshotai/kimi-k2`) and supply the OpenRouter key via `auth_token`.
- `mode: default` — native Anthropic (unchanged behaviour).

Also advertises the gateway models (`kimi-k2.7-code`, `z-ai/glm-5.2`, `deepseek/deepseek-v4-pro`, `moonshotai/kimi-k2`) in `models.allowed` alongside the native Claude ids. The `model` option stays free-form, so any gateway id works even if unlisted. No change to native Anthropic use.
