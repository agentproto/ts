---
"@agentproto/app-kit": minor
"@agentproto/runtime": minor
"@agentproto/driver": patch
"@agentproto/driver-http": patch
---

Apps may now bundle their own AIP-14 `TOOL.md` contracts and AIP-30 `DRIVER.md` implementations (`kind: cli`/`http`) under `.agentproto/tools/<id>/TOOL.md` and `.agentproto/drivers/<id>/DRIVER.md`. `loadAppHandle` (app-kit) discovers and loads them; the runtime's `compileWorkflow` seam merges an app's own tools/drivers over the daemon passthrough registry for every `WORKFLOW.md` `tool` step it owns, with an app tool id winning over a daemon tool of the same id. `driver` gains `driverDefinitionFromManifest`, factored out of `driverFromManifest` so kind-specific sugars can build from a DRIVER.md manifest directly. `driver-http`'s non-2xx errors now include a body excerpt, not just the status code.
