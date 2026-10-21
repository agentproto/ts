---
"@agentproto/adapter-claude-code-cloud": minor
"@agentproto/runtime": minor
---

Claude Code cloud sessions can now run on a workspace's declared remote (`workspaces.json` → `remote`, set with `agentproto workspace remote set`), the same way a sandbox spawn gets its checkout. You no longer need a local clean, pushed clone.

`@agentproto/runtime`: a `cloud` spawn (and its restart) on a workspace with a declared `remote` passes the url, branch and a checkout dir inside the session's isolated config dir to the relay. A `credentialRef` is resolved from the keychain into `AGENTPROTO_GIT_TOKEN`; a ref that resolves to nothing refuses the spawn (`cloud_spawn_refused`, field `workspace.remote.credentialRef`). New `cloudRepoSpawnEnv` / `cloudRepoCheckoutDir` helpers.

`@agentproto/adapter-claude-code-cloud`: new `materializeRepoCheckout`. With `AGENTPROTO_CLOUD_REPO_URL` + `AGENTPROTO_CLOUD_REPO_DIR` set, `session/new` and `session/load` shallow-clone `origin/<branch>`, or fetch and hard-reset an existing checkout. That checkout must pass the usual AIP-66 §3 validation, and `claude --cloud` then runs from it. The git token is only ever read by a per-command credential helper and is removed from the vendor CLI's env.
