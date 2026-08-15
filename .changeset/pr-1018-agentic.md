---
"@agentproto/adapter-claude-sdk": patch
---

Fix: Fail fast on unrouted vendor/product model IDs to prevent silent billing issues.

When a gateway model (e.g., `deepseek/deepseek-v4-flash-0731`) reaches `buildQueryOptions()` without a `base_url` to route it through, it would previously be sent directly to the real Anthropic API — resulting in one of three silent failures: an empty turn still billed, a 400 error, or worst, a silent fallback to a real Claude model billed to Anthropic. The guard now throws `UnroutedGatewayModelError` before any request is made, with a clear error message naming the model and suggesting the fix (set a `base_url` or request a native `claude-*` model instead).

Exports the new `UnroutedGatewayModelError` class for pattern-matching if hosts wish to distinguish this failure mode.
