---
"@agentproto/runtime": patch
---

Session cost now prices router ids on the router's own rate. `opencode-go/kimi-k3`, `opencode/claude-sonnet-4-6`, `vendor/model@requesty`, `vendor/model@openrouter` and `vendor/model@huggingface` resolve through their route table instead of falling through `resolvePricing`'s substring scan onto the direct vendor row (which priced `opencode-go/kimi-k3` at direct Moonshot rates). A router id missing from its router's table is now reported as `no-pricing` rather than borrowing the vendor's price. Bare ids and OpenRouter-native `vendor/model` ids are unchanged.
