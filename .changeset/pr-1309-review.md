---
"@agentproto/model-catalog": patch
"@agentproto/catalog-sync": patch
"@agentproto/provider-presets": patch
"@agentproto/providers-store": patch
"@agentproto/runtime": patch
"@agentproto/adapter-claude-code": patch
"@agentproto/adapter-claude-sdk": patch
"@agentproto/adapter-opencode": patch
---

Add OpenCode's two hosted endpoints as first-class billing providers: `opencode-go` (OpenCode Go, the flat subscription, 36 models) and `opencode` (OpenCode Zen, pay-as-you-go, 102 models). Two new catalog-sync generators (`llm:opencode-go`, `llm:opencode-zen`) source both from models.dev and emit `OPENCODE_GO_ROUTES` / `OPENCODE_ZEN_ROUTES`, each with a pruned per-provider snapshot rather than the 4.6 MB whole-ecosystem payload. Prices are used verbatim (models.dev already publishes USD per 1M tokens); zero-priced `-free` variants are kept, and cache multipliers are omitted where the base input price is 0.

Route tables are keyed `<provider>/<bare-id>` (`opencode-go/glm-5.3`) — opencode's own config spelling, and the same string the runtime derives the billing endpoint from — so `resolveLlmModelRoute` resolves the OpenCode branch ahead of the direct-vendor branch. Neither table is spread into `LLM_PRICING_CATALOG`, so a bare `claude-sonnet-5` keeps meaning direct Anthropic rather than Zen pricing.

Two Anthropic gateway presets (`opencode-go`, `opencode`) put each endpoint's Anthropic-surface models behind claude-code / claude-sdk — Zen's subset is the whole Claude family. Preset ids deliberately match the catalog route ids, since `resolveAuthSpec` resolves a spawn's base URL by route id. The opencode adapter now offers both endpoints in full in its generated model menu.

Fixes two spillovers found along the way: `serviceableModelRoutes` no longer reports a spurious direct-vendor route for a self-routed id (`opencode/claude-sonnet-4-6` had picked up `anthropic` via `resolvePricing`'s substring fallback, loosening the money-safety guard and mis-routing the Configuration Lab), and `injectProviderKeysIntoEnv` now visits providers in sorted order so two providers sharing one env name (both OpenCode endpoints read `OPENCODE_API_KEY`) resolve deterministically instead of by `providers.json` write order.
