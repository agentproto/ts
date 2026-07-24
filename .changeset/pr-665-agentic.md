---
"agentproto-vscode": minor
---

Refactor session grouping from two independent boolean toggles to a single multi-choice setting. Add new status-based grouping dimension (Awaiting you / Live / Failed / Stopped / Done) alongside existing workspace and origin grouping modes. Introduce three new commands: `setSessionGrouping` (QuickPick selector), `expandAllSessions` (bulk-reveal groups), and `cleanEndedSessions` (bulk-archive). Maintain backward compatibility via deprecation migration from `groupByWorkspace` / `groupByOrigin` settings to new `sessionGrouping` enum.
