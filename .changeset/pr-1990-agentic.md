---
"@agentproto/storage-github": patch
---

Fix GitHub token authentication for git commands: `buildGitEnv` now carries the token as an `http.https://github.com/.extraheader` config entry via git's native `GIT_CONFIG_COUNT` / `GIT_CONFIG_KEY_0` / `GIT_CONFIG_VALUE_0` mechanism instead of the non-existent `GIT_HTTP_EXTRAHEADER`, restoring authenticated clone/fetch/push against private repos.
