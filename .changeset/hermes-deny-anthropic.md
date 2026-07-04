---
"@agentproto/driver-agent-cli": minor
"@agentproto/adapter-hermes": minor
---

Add `models.deny` to the agent-CLI manifest and reserve Anthropic models for the claude-code adapter.

`models.allowed` is a curated menu — the `model` option stays free-form, so it can't *prevent* a caller passing an off-menu id. The new `models.deny` array is the hard guardrail: model ids matching a deny pattern (case-insensitive, trailing `*` = prefix) are refused at compose time (`RuntimeConfigError`, code `model_denied`), before spawn. hermes now declares `deny: ["anthropic/*", "claude-*"]` and drops its Anthropic env/auth slots, so the budget arm can no longer be steered onto premium Anthropic spend — those stay exclusive to claude-code. Cheap OpenRouter models (glm, deepseek, kimi, qwen, …) are unaffected.
