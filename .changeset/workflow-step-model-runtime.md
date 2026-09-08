---
"@agentproto/runtime": minor
---

`WorkflowRunner` steps (`kind: agent`) accept an optional `model` field — same semantics as `agent_start.model`. The runner threads it onto the spawn exactly like `adapter`; absent means unchanged behaviour. For a cacheable step the resolved model is part of the cache entry key, like the adapter.
