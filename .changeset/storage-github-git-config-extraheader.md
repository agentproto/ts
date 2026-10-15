---
"@agentproto/storage-github": patch
---

Fix GitHub token authentication for git commands: `buildGitEnv` now injects the token as an `http.https://github.com/.extraheader` config entry via `GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_0`/`GIT_CONFIG_VALUE_0` instead of `GIT_HTTP_EXTRAHEADER` (a variable git does not implement — the header never reached the wire, so private-repo clones 401'd and pushes were unauthenticated).
