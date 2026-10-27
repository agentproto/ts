---
"@agentproto/session-presets": minor
"@agentproto/harness": minor
"@agentproto/worktree": patch
"@agentproto/sandbox-box": patch
"@agentproto/sandbox-computer": patch
"@agentproto/sandbox-e2b": patch
"@agentproto/sandbox-instabox": patch
---

Move the typed session presets from `@agentproto/harness` to `@agentproto/session-presets`. This is step 1 of 2 for AIP-45: `@agentproto/harness` becomes a deprecated re-export shim so the name can be reused by the harness runner in its next major. `@agentproto/worktree` now imports the new package. The sandbox providers only update a doc comment that names the package, so they take a patch bump to satisfy the changeset coverage gate.
