---
"@agentproto/workflow-mastra": minor
---

Projected workflows now carry real schemas instead of `z.any()` everywhere: the workflow's own `inputSchema` is built from the declared AIP-16 `inputs` block (rejecting invalid input before any step runs), and tool/agent steps project their real declared `outputSchema`. A top-level `suspend`/`approval` step now projects to native Mastra `suspend()`/`resume()` instead of failing loud (still refused when nested inside a branch/parallel/loop/map/group, where there's no per-step suspend boundary). `gate` is now refused explicitly with a stated reason instead of silently reaching an unhandled case in the local step-walker. Adds an AIP-58 conformance harness (`aip58-conformance.mastra.test.ts`) driving the same vendored vectors through `toMastraWorkflow` — V1 green, V2-V8 tracked as `it.todo`.
