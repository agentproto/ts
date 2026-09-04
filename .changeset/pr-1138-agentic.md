---
"@agentproto/cli": minor
---

Add support for PORT environment variable in app port resolution. New exported `resolveRequestedPort()` function enables launchers (like Claude Code's autoPort) to assign ports dynamically. Port resolution priority: explicit `--port` > `PORT` env > declared `ui.port` > auto-assign.
