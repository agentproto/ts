---
"@agentproto/runtime": patch
---

Fix: `session_list` MCP tool and `GET /sessions` HTTP endpoint now exclude shell-command runs (`kind:"command"`) from the default view, since commands are execution logs—not resumable sessions—and were cluttering the UI. Commands remain fully accessible via explicit `kind:"command"` filter or `includeCommands:true` parameter (HTTP endpoint and MCP tool). Internal UI panels (sessions/agents-overview/bureau/session-story) now filter to live-able sessions only, matching the new default semantics.
