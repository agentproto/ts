---
"@agentproto/runtime": patch
---

Carry the CALLER SESSION IDENTITY of a daemon-spawned session on its `/mcp` mount in a header as well as in the URL query, and recognize the daemon's own endpoint by origin + path instead of by exact string.

A session that reaches the daemon anonymously is a session the daemon cannot reason about: `message_parent` answers "cannot identify the calling session", and every spawn that session makes lands as a depth-0 orphan with no parent (the auto-parent has no identity to derive - see `spawn-attach.ts`).

- The identity now travels two ways on a daemon mount: the `?callerSessionId=` query (unchanged, still the form the trust checks read) and a new `x-agentproto-caller-session-id` header. A URL query is the fragile carrier - a client or an intermediary that rebuilds the mount URL drops it - while the header travels with the request whatever the client does to the URL. The gateway reads whichever carrier survived (the query wins when both are present), and the header is honoured on the same trust footing as a query claim (loopback socket or a valid daemon bearer).
- A mount is recognized as "this daemon's own `/mcp` endpoint" by origin (host:port) and path, not by exact string equality. An ambient mount (a project `.mcp.json`, an operator's global MCP config, a config a supervisor passed down) spells the same endpoint differently - `localhost` vs `127.0.0.1`, a trailing slash, a `?host=...` query - and every one of those spellings used to fail the exact match, so the mount was never identity-stamped. A foreign endpoint, and the scoped `/mcp/orchestrator` sub-gateway (which attributes through its own scope token), are still left untouched.
- A restart or a continue-fresh strips the retired session's own identity header alongside its own query stamp, so a fresh session never keeps speaking to the daemon under the dead session's id.
