---
"@agentproto/llm-endpoint": minor
---

Add Anthropic-style format feature and curated coding pack. Enables any pack to be relabeled on-the-fly with opaque `claude-<family>-<sha>` IDs for Anthropic-only clients without impersonating real Claude models. Introduces codingPack with production-grade models via OpenRouter (GPT-5.5, Claude Opus 4.8, Deepseek v4, Claude Sonnet 5, GLM 5.2, Minimax m3). Feature is opt-in via `X-Proxy-Format: anthropic` header or `?format=anthropic` query param.
