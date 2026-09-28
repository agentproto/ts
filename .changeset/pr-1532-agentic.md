---
"@agentproto/worktree": patch
---

Test-only fix: disable git auto-maintenance in worktree test fixtures via a vitest setup file (GIT_CONFIG_* env overrides) plus per-repo `maintenance.auto=false` for bare origins, since `receive-pack` strips the pusher's GIT_CONFIG_* env. Prevents flaky `ENOTEMPTY` cleanup failures from `git maintenance run --auto` holding locks during afterEach teardown.
