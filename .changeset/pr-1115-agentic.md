---
"agentproto-vscode": patch
---

Fix Stop-button regression on live extra sessions. The button click handler now uses the same row pool as the render path, so sessions rendered past the paginated slice can always be resolved when actions are triggered.
