---
"@agentproto/runtime": patch
---

MCP modern era (`2026-07-28` on `/mcp`): a refused MRTR retry (altered, expired, replayed, foreign or malformed `requestState`, or a caller not allowed to resolve the input) and the Skills invalid params (unknown skill or file, unissued cursor, `skill://` traversal) now answer `-32602` with HTTP 400, as AIP-77's error mapping gives, instead of HTTP 200. Other handler errors and the legacy era are unchanged.
