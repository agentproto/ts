---
"@agentproto/cli": minor
"@agentproto/runtime": minor
---

`app_install {dir}` no longer silently re-points an app installed from a live dir into a linked git worktree: that is refused unless `repoint: true` (CLI `agentproto app install <dir> --repoint`), so `agentproto maintain` / `steward` run from a worktree build keep the installed copy. The daemon also self-heals a `dir-missing` record left by a removed worktree by re-pointing it at the main worktree's copy of the same app (fail-closed), reported as a `dir-repointed` registry issue.
