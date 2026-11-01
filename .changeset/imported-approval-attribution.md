---
"@agentproto/runtime": patch
---

Approval holds and node scope for imported-MCP calls now use the calling session on the `/mcp/imported` passthrough, `POST /mcps/proxy/call` and `transmit_message`, A caller-supplied imported mount is now stamped with the session id at spawn like the daemon self-mount (a bundle's imported mounts already named the session in their URL; they also gain the identity header). Calls with no caller are unchanged.
