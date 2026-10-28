---
"@agentproto/runtime": patch
---

A session spawned into an async-provisioned worktree (the default for worktree spawns) now starts its driver with the same env as a synchronous spawn: `AGENTPROTO_SESSION_ID`, `AGENTPROTO_WORKSPACE_SLUG`, `AGENTPROTO_PARENT_SESSION_ID`, `AGENTPROTO_APP_ID`, the cloud relay vars, and the `gh` provenance shim on PATH when `provenance.wrapGh` is on. Before, that lane passed no `env` at all, so a `gh pr create` run from the child's own shell was never stamped with the `@agentproto-bot` footer.
