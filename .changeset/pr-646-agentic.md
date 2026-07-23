---
agentproto-vscode: minor
---

Add daemon configuration UI surface (`agentproto.showDaemonConfig`) — a QuickPick that displays and edits daemon behavior knobs (`resumeSessionsOnBoot`, `idleReapAfterMs`) directly from VS Code, with live-vs-persisted reconciliation and restart-pending detection. Also extend `DaemonHealth` type with optional fields for the two behavior knobs surfaced by `/health`.
