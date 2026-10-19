# @agentproto/model-intel

## 0.3.0

### Minor Changes

- 7bf4955: Add `diffCatalog` (pure catalog-snapshot diff: appeared/removed/priceChanged/freeToPaid/paidToFree) to `@agentproto/model-intel`, and a `catalog_diff` MCP tool in `@agentproto/runtime` backed by a persisted snapshot store — plus a `model-catalog-watch` app (daily cron routine + workflow: sync → diff → gate → free-model digest).
- 7bf4955: Add `diffCatalog` (pure catalog-snapshot diff: appeared/removed/priceChanged/freeToPaid/paidToFree) to `@agentproto/model-intel`, a persisted-baseline `catalog_diff` MCP tool to `@agentproto/runtime`, and ship the `model-catalog-watch` bundled app (daily cron routine + `watch` workflow: sync → diff → gate → free-model digest) in `@agentproto/apps`.

## 0.2.0

### Minor Changes

- c6ddf99: Add a Moonshot balance quota reader (`createMoonshotQuotaReader`) and a pure Codex `rate_limits` parser (`quotaFromCodexRateLimits`).

## 0.1.0

### Minor Changes

- 1962319: Add `@agentproto/model-intel`: the AIP-67 `QuotaStatus` shape with a mandatory `basis`, the never-throw `QuotaReader` contract, and a reader registry.
- 1962319: Add `@agentproto/model-intel`: the `quota/v1` `QuotaStatus` shape with a mandatory `basis`, the never-throw `QuotaReader` contract, a reader registry, and two core readers — `quotaFromAnthropicHeaders` (parses Anthropic's documented rate-limit headers) and `createOpenRouterQuotaReader` (reads OpenRouter `/key` quota). Unknown is omitted, never fabricated.
