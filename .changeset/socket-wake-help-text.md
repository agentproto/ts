---
"@agentproto/runtime": patch
---

Fix the `daemon.claudeSocketWake` help text, config type comment and docs: a `bypassPermissions` Claude Code target is no longer described as falling back to the inbox. It is written to over the socket, and Claude Code holds the message until `crossSessionInbound` is `accept` (`agentproto doctor --fix`).
