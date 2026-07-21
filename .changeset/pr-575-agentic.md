---
"@agentproto/runtime": patch
---

Add optional `origin` field to session descriptors to track the source/channel (vscode, codex, cron, etc.) that spawned a session. The field flows through spawn inputs and persists for session lineage visibility in the tree view.
