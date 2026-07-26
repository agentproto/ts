---
"@agentproto/adapter-claude-sdk": minor
---

Add extended idle timeout for tool execution in Claude SDK adapter. Prevents generation watchdog from aborting healthy long-running tool calls that legitimately go silent between `tool_use` and `tool_result` messages. Introduces `toolIdleTimeoutMs` config option (default 10 minutes) and `CLAUDE_SDK_TOOL_IDLE_TIMEOUT_MS` environment variable.
