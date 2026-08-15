---
"@agentproto/runtime": patch
---

Document `agent_start(wait: true)` serialization behavior. Batching multiple `wait: true` calls in a single turn serializes them (caller-side harness limitation, not daemon bug). Includes clear workaround patterns for parallel fan-out using `wait: false` + `agentproto sessions wait` or `policy_attach`.
