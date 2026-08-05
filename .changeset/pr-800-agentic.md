---
agentproto-vscode: minor
---

Add origin-based session filtering and separate machine-origin sessions in the status bar and tree view. Introduces `agentproto.hideMachineSessions` setting (default: true) to suppress automated gate-review sessions by default while keeping them visible in a separate status-bar segment and tree icon with "verified" icon instead of "plug".
