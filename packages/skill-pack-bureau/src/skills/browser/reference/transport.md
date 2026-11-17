Bureau is a local MCP server: the MCP endpoint is `http://127.0.0.1:8830/mcp`,
`GET /health` is open and every other route needs a paired device. Pair once
with `bureau install-mcp`, which writes a bearer into the client config, then
call the tools; if a call fails at the transport layer, check that `bureau
start` is running and that the client entry points at `:8830/mcp`. When
agentproto drives a call it mints a sub-session per agent session and sends it
in the `Agentproto-Subsession` header next to `Authorization`: that token is the
only trusted source of `callerSessionId`, which is what makes a tab yours, while
a call without the header is device-level, has no `callerSessionId` and cannot
act on a session-owned tab, and an invalid or expired sub-session answers
`subsession_invalid` or `subsession_expired` and is never downgraded to a
device-level call.
