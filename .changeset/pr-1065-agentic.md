---
"@agentproto/workflow": minor
"@agentproto/workflow-runtime": minor
---

Add declarative `onError: "collect"` support to workflow map steps. The runtime previously supported per-item error collection via `MapStep.onError`, but the declarative manifest layer did not expose this field. This change:

- Adds `onError?: "throw" | "collect"` to the `StepMap` interface in `@agentproto/workflow`
- Updates the compiler to read and propagate `onError` from declarative steps to compiled runtime steps
- Includes comprehensive test coverage for the collection behavior with mixed success/failure outcomes
