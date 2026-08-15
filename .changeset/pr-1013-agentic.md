---
"@agentproto/runtime": patch
---

Fix transcript discovery for daemon-spawned claude-code sessions with isolated CLAUDE_CONFIG_DIR. Since the #824 MCP-isolation fix, daemon-spawned sessions write their transcripts under their own isolated config directory, not the global ~/.claude. Discovery and read operations now correctly resolve transcripts from the session's isolated directory when available, while maintaining backward compatibility with pre-#824 sessions and native PTY sessions that use the global store.
