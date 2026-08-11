---
"@agentproto/acp": patch
"@agentproto/runtime": patch
"agentproto-vscode": patch
---

Add optional title field to plan events, displayed in VS Code conversation UI. Titles are safely threaded through ACP client translation, runtime event stream, and conversation presenter, supporting both immediate titles and late-binding (title added in subsequent plan updates).
