---
"@agentproto/session-presets": minor
"@agentproto/harness": minor
"@agentproto/worktree": patch
"@agentproto/sandbox-box": patch
"@agentproto/sandbox-computer": patch
"@agentproto/sandbox-e2b": patch
"@agentproto/sandbox-instabox": patch
---

Move the typed session presets from `@agentproto/harness` to `@agentproto/session-presets`. This is step 1 of 2 for AIP-45: the presets moved to `@agentproto/session-presets`, and the name `@agentproto/harness` now carries the AIP-45 runner (see the aip-45 changeset). `@agentproto/worktree` now imports the new package. The sandbox providers only update a doc comment that names the package, so they take a patch bump to satisfy the changeset coverage gate.
