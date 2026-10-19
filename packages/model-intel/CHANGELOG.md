# @agentproto/model-intel

## 0.2.0

### Minor Changes

- c6ddf99: Add a Moonshot balance quota reader (`createMoonshotQuotaReader`) and a pure Codex `rate_limits` parser (`quotaFromCodexRateLimits`).

## 0.1.0

### Minor Changes

- 1962319: Add `@agentproto/model-intel`: the AIP-67 `QuotaStatus` shape with a mandatory `basis`, the never-throw `QuotaReader` contract, and a reader registry.
- 1962319: Add `@agentproto/model-intel`: the `quota/v1` `QuotaStatus` shape with a mandatory `basis`, the never-throw `QuotaReader` contract, a reader registry, and two core readers — `quotaFromAnthropicHeaders` (parses Anthropic's documented rate-limit headers) and `createOpenRouterQuotaReader` (reads OpenRouter `/key` quota). Unknown is omitted, never fabricated.
