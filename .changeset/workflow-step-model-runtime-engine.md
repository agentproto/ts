---
"@agentproto/workflow-runtime": minor
---

`AgentStep` accepts an optional `model` field — a literal string or a per-run selector (`(bindings) => string | undefined`), same style as `adapter`. It is resolved per run and forwarded to the spawn through the harness slot (the channel both spawn paths already apply as the session's model, matching `agent_start.model` semantics); an explicit `harness.model` pinning wins. For a cacheable step the resolved model joins the prompt/adapter in the resolved-inputs hash, so a model change is a cache miss.
