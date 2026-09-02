---
"@agentproto/runtime": patch
"agentproto-vscode": minor
---

Fix session exit code classification to correctly handle node-pty's `{ exitCode: 0, signal: 0 }` clean-exit shape — `signal: 0` was being misclassified as "a signal fired" instead of "no signal."

Add row disclosure triangles to the VS Code webview sessions list, enabling collapse/expand of nested subagent hierarchies. Collapsed rows show the busiest descendant status in their dot indicator.
