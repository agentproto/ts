---
"@agentproto/worktree": patch
---

Fix expandGlob stack overflow on large repos by skipping node_modules and avoiding spread-push
