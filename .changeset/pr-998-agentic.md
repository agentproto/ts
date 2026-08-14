---
"agentproto-vscode": minor
---

Fix session lineage handling in the webview: subagents spawned under human chat sessions now stay in the agents lane (nested under their spawner) rather than routing to the auto lane's Tasks group. Orphans and children of machine-origin sessions correctly fall back to Tasks. Includes cycle detection to prevent infinite loops in parent chain traversal.
