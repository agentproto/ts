---
"@agentproto/runtime": minor
---

Add `extractToolResultSessionId()` utility to extract and validate session identifiers from tool result payloads, supporting both `agent_start` descriptors (id field) and `live_session` results (sessionId field). This enables proper session pinning in the live-session widget to display the session spawned by a tool call rather than auto-discovering the newest session.
