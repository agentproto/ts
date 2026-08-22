---
"@agentproto/cli": patch
"@agentproto/runtime": patch
---

Fix "restart starts a terminal but it doesn't work" bug: add origin-gate that prevents agent-cli/ACP-origin sessions from defaulting to provider-native terminal restart. ACP-origin sessions now default to agent-level resume, with explicit opt-in via `preferNativeTerminal` flag. Implement billing-auth re-resolution for pty-native path to prevent ambient credential leaks, closing #824/#490 for this codepath.
