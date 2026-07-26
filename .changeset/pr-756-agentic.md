---
"agentproto-vscode": minor
---

Add daemon connection state tracking to VS Code extension for improved first-run UX. Users now see a clear "connecting" state while awaiting the daemon, and an actionable "unreachable" screen if the daemon is not running. Exports `DaemonConnectionState` type and adds `connectionState` getter to SessionStore.
