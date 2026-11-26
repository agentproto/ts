---
"@agentproto/runtime": minor
"@agentproto/mcp-server": minor
---

Serve the MCP Events extension (`io.modelcontextprotocol/events`): add `events/poll` (pull delivery, no prior subscribe), backed by a durable per-`(name, arguments)` journal and a shared, idle-released provider watch, with an opaque cursor, `maxAgeMs`, `maxEvents`, `hasMore`, `nextPollMs` and `truncated` (a cursor older than the journal, the retention or a watch gap reads as truncated, never an error). `server/discover` now declares the extension next to `events:{}`; `events/list` reports the delivery modes really offered per type and omits `nextCursor` on the last page; `events/unsubscribe` accepts `delivery: { url }` without `mode`; `Mcp-Name` is required on poll, subscribe and unsubscribe; errors use the standard codes `-32023` to `-32027` (backing-subscription failures are `-32603` with `data.kind`), with the old `-32015`/`-32016` kept in `data.legacyCode` for one release. The public events origin applies its repo allowlist to `events/poll` (`-32024`). The extension can be switched off with `mcp.eventsExtension: false`, which keeps the three webhook methods.
