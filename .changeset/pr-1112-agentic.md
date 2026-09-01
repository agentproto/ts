---
"agentproto-vscode": minor
---

Add browser live-view panel and session-routing logic for opening sessions by kind. Introduces `agentproto.openSession` command that routes to the terminal, browser live view, or webview chat panel based on session kind, plus `agentproto.openBrowser` for explicit browser-session opening.
