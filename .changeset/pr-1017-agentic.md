---
"@agentproto/runtime": patch
---

Fix regression where pty-native session restarts lost the isolated config directory, causing provider resume to fail with "No conversation found". Add env-var threading support (CLAUDE_CONFIG_DIR) for session restarts with proper replay across pty-plain restart chains. Improve observability for abnormal PTY exits by capturing and surfacing diagnostic output.
