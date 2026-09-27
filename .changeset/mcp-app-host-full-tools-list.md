---
"@agentproto/runtime": patch
---

Follow-up to the MCP Apps host's app-UI `callTool` gate (#1459), which now needs the hosting server's FULL tool list to decide app-visibility. Two gaps in getting that list: `PooledMcpClient` read only the first `tools/list` page, so a server that paginates (`nextCursor`) would have every page-2+ tool refused as "does not exist" — it now loops on `nextCursor` until exhausted (capped at 50 pages). And an executor session's daemon self-mount carries `?deferred=1`, which makes the daemon's own `tools/list` return only its always-on subset (`tools/call` is unaffected — deferred is listing-only); the host built its own connection from that same session config and inherited the restricted listing, so every deferred tool also read as nonexistent. The host now strips `deferred` from a session entry's url before connecting — only its own listing changes, the agent's mount is untouched.
