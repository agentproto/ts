---
"@agentproto/workflow-loader": patch
"@agentproto/workflow-runtime": patch
---

AIP-15 `subworkflow` steps: the loader now compiles a declarative `with:` block into the step's `inputs` projection (AIP-16 ref grammar — literals, `$input.*`, `$steps.<id>.*`, resolved against the parent's bindings), so the child receives the mapped object instead of the parent's raw input verbatim; steps without `with:` are unchanged. `with` and `inputs` on the same step is a load error, and a `with:` ref to an unknown step id is rejected at load time naming the step and key. The runtime compiler's subworkflow projection is now strict: a referenced field that does not exist throws at run time naming the subworkflow step and key instead of silently passing `undefined`. Spec: `with` semantics added to `stepSubworkflow` in `specs/resources/aip-15/draft/WORKFLOW.schema.json`.
