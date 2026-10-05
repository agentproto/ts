---
"@agentproto/runtime": patch
---

Review lanes fail closed on OpenRouter: the daemon reviewer host now refuses to spawn a lane whose preset, model, or auth profile (billing endpoint) resolves to OpenRouter, returning a failed review with a message pointing at opencode-go / Claude-subscription presets instead of silently spending pay-per-token credit.
