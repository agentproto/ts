---
"@agentproto/cli": patch
"@agentproto/runtime": patch
---

New config key `worktrees.extraRoots`: extra directories `maintain --all` scans for worktrees, so scheduled maintenance routines cover pools outside the worktrees root without passing `--worktrees-root` on every run. The flag still adds to the list.
