---
"@agentproto/runtime": patch
---

Add daemon-supervised sidecar manager for the @agentproto/llm-endpoint proxy. Implements LlmEndpointRegistry for full lifecycle management (start/stop/status) with concurrency-safe dedup, idempotency, health probing, and MCP tool bindings. Fixes concurrent-spawn orphan leak (Fix 1) and improves crash error visibility with log tail (Fix 2).
