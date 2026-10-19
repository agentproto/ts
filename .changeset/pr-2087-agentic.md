---
"@agentproto/model-intel": minor
---

Add `@agentproto/model-intel`: the `quota/v1` `QuotaStatus` shape with a mandatory `basis`, the never-throw `QuotaReader` contract, a reader registry, and two core readers — `quotaFromAnthropicHeaders` (parses Anthropic's documented rate-limit headers) and `createOpenRouterQuotaReader` (reads OpenRouter `/key` quota). Unknown is omitted, never fabricated.
