---
"@agentproto/runtime": minor
"agentproto-vscode": minor
---

Add terminal input endpoint and UI toggle for conversation/terminal view switching.

- HTTP endpoint `POST /sessions/:id/terminal/input` for writing raw input to PTY sessions (FIX 2)
- DaemonClient method `writeTerminalInput` for terminal input requests
- VSCode UI: Conversation⇄Terminal segmented toggle for sessions with both representations
- Routing: Terminal sessions now use `writeTerminalInput` instead of `prompt` endpoint
- View toggle logic for agent-cli and native-conversation PTY sessions
