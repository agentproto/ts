---
"agentproto-vscode": minor
---

Pinned-group ordering in the sessions webview: rows sort by the daemon-persisted `pinnedOrder` (legacy pins last), with hover-revealed ↑/↓ buttons on pinned root rows that call the new `POST /sessions/pinned/order` via `DaemonClient.reorderPinned`. A pinned session receiving a message no longer moves within the Pinned group.
