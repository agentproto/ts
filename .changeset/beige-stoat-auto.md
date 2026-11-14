---
"@agentproto/runtime": patch
---

New read-only daemon tool `session_screencast_frame { sessionId }`: returns the same frame `GET /sessions/:id/screencast.jpg` serves (a Bureau screenshot of the session's own newest open tab) as one MCP `image` block, or one fixed error message ("No open browser tab for this session.") on any miss. The screencast reader is now created once in `createGateway` and shared by the route and the tool, so the 800 ms frame cache and the 2-capture cap are not split. A caller session (`callerSessionId`, or a scoped orchestrator's owner) may only read its own tab; the tool is outside every agent-scoped profile and has no link-token path.
