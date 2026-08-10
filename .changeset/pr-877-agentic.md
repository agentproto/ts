---
"agentproto-vscode": minor
---

Add installed app UI panel support: new tree view for discovering daemon-installed apps that ship a UI, webview panels to host app UIs (via MCP resources/read), and commands to open/refresh apps. Introduces DaemonClient methods listApps(), appToolCall(), and readResource() to support MCP-Apps protocol.
