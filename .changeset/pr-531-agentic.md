---
"@agentproto/runtime": patch
---

Fix linked git worktree session workspace resolution: sessions spawned in linked worktrees now group under their base repo's registered workspace instead of falling back to "default". Also adds symlink-aware path comparison to handle macOS `/tmp` → `/private/tmp` aliases.
