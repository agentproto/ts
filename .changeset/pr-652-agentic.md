---
"agentproto-vscode": minor
---

Add "Group By Origin" feature to sessions panel. Sessions can now be grouped by their source (Claude Code desktop, VS Code extension, cron, etc.) via a new toolbar toggle. When enabled, this grouping takes precedence over workspace grouping. Children nest under their root's origin group regardless of their own origin. New origins render under their raw slug without code changes.
