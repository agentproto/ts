---
"@agentproto/worktree": minor
---

Add declarative `worktree.depsCmd` and `worktree.linkPaths` to `agentproto.json`, used as fallbacks by `worktree.provision` when the corresponding tool inputs are omitted. Explicit tool inputs still win, and the `runSetup` gate now also covers the declarative `depsCmd`/`linkPaths` lifecycle.
