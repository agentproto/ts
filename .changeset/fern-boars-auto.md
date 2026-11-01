---
"@agentproto/cli": minor
"@agentproto/runtime": minor
---

`app_install {dir}` no longer silently re-points an app installed from a live dir into a linked git worktree (refused unless `repoint: true`, CLI `agentproto app install <dir> --repoint`); `agentproto maintain` / `steward` keep the installed copy when run from a worktree build. The daemon now heals a `dir-missing` record left by a removed worktree by re-pointing it at the main worktree's copy of the same app, reported as a `dir-repointed` registry issue.
