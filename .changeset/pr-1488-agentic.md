---
"@agentproto/llm-endpoint": minor
---

Merge top-level `system`/`instructions` and any non-leading `system`/`developer` messages into a single leading system message in both the Anthropic→OpenAI adapter and the Responses→ChatCompletions translator, preventing strict chat templates from rejecting mid-conversation system messages. Adds upstream error-status logging to the proxy and exports `adaptAnthropicToOpenAI` / `translateInputToMessages` for testing.
