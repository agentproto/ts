---
"agentproto-vscode": patch
---

Only persist the watched-sessions activity baseline when it actually changes, avoiding a workspaceState write on every poll.
