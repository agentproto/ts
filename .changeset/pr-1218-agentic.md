---
"@agentproto/runtime": patch
---

Add structured event streaming support to sandbox proxy via `/sessions/:id/events/stream` SSE endpoint, preserving tool-call and usage_update fidelity end-to-end. Falls back gracefully to legacy flattened-text poll behavior for older or unreachable box daemons.
