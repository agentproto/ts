---
"@agentproto/runtime": minor
---

MCP Events push delivery: `events/stream` and `notifications/events/*` on the 2026-07-28 era of `/mcp` and on the public events origin. A stream is a third read of the same journal as `events/poll` (same validation, same shared watch, same cursor format, interchangeable with poll), answered as SSE with `notifications/events/active`, `event`, `heartbeat`, `error` and `terminated`, and a final frame when the server closes it. `events/list` lists `push` on the modern era only; the legacy era keeps `["poll", "webhook"]`. Set `mcp.eventsStream` to `false` to stop serving it (404 `-32601`) and stop advertising `push`.
