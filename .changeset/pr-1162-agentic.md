---
"@agentproto/app-client": minor
"@agentproto/cli": minor
"@agentproto/runtime": minor
"create-agentproto-app": patch
---

Add `@agentproto/app-client/runner-select` — a shared harness+model selector for app UIs that discovers installed harnesses via `adapter_list` + `harness_preset_list`, eliminating per-app picker implementations. Automatically injected into every app UI alongside the McpApp bridge. Supporting changes: `adapter_list` summary mode for lightweight UI projections, harness preset profile status enrichment (disabled/missing flags), early validation of default preset profiles during spawn, and discovery tool allowlisting for all app UIs.
