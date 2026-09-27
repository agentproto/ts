---
"@agentproto/runtime": patch
---

Fix two dogfood frictions: `tool_search` now weights a query term matching a tool's own name far above an incidental mention in another tool's description, so a real `workflow_*` tool can no longer be crowded out of a capped result by an unrelated tool's prose (F39); and `workflow_run_file` now resolves a `kind:"tool"` step's TOOL.md/DRIVER.md bundle from the given WORKFLOW.md's own directory (walking up to its app root) instead of always the `app_install` registry's dir, so running a WORKFLOW.md from a worktree copy of an installed app no longer silently executes the installed copy's scripts (F40).
