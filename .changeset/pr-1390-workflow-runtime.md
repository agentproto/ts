---
"@agentproto/workflow-runtime": minor
"@agentproto/runtime": minor
---

AIP-58 conformance harness (V1 green, V2-V8 tracked as `it.todo`) plus workflow input validation: a `WORKFLOW.md`'s shorthand `inputs` map now normalizes to JSON Schema, and a run with missing/invalid required input is rejected as `error.code = "invalid-input"` before any step runs.
