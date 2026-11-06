---
"@agentproto/runtime": patch
"@agentproto/cli": patch
---

Claude Code 2.1.317 writes no permission mode to `~/.claude/sessions/<pid>.json`, so a session started in bypassPermissions was treated as wakeable and a daemon message was reported delivered over the socket without reaching it. `agentproto hook inbox` now forwards the hook input's `permission_mode` on the touch, the external row records it (`externalPermissionMode`, refreshed on every touch that carries one), and the socket wake falls back to the inbox when the registration file or the row says bypassPermissions.
