---
"@agentproto/workflow": minor
---

Declarative agent steps (`kind: agent`) accept an optional `model` field (model id override forwarded to the spawn — same semantics as `agent_start.model`). A non-string `model` fails validation with a clear diagnostic; an explicit `harness.model` pinning still wins.
