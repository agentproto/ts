---
"@agentproto/runtime": patch
---

Attribute imported-MCP calls to the calling session on the `/mcp/imported` passthrough, `POST /mcps/proxy/call` and `transmit_message`/`sendOutbound`, and stamp imported-passthrough mounts with the session id (query + identity header, never the session token) at spawn, restart and fresh continue. Calls with no caller remain host calls. This mirrors the changeset already present in the PR (`.changeset/imported-approval-attribution.md`); it is recorded here only as the reviewer's proposed changeset.
