---
"@agentproto/cli": patch
---

`maintain --all` now finds worktrees placed directly at the worktrees root (`<root>/<slug>`, no repo bucket), and takes a repeatable `--worktrees-root <dir>` to scan pools outside the configured root, so repos whose worktrees live elsewhere are no longer skipped.
