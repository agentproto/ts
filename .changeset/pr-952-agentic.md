---
"@agentproto/adapter-mastra-agent": patch
---

Fix: drop reasoning-only assistant messages instead of injecting empty text blocks. The Mastra adapter was filtering out trailing reasoning blocks but then injecting empty text blocks as a fallback, which violates Anthropic's API contract ("text content blocks must be non-empty"). Now reasoning-only messages are properly dropped entirely, which is safe because they carry no tool calls.
