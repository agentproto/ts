---
"@agentproto/runtime": patch
---

Forward the `trace` flag through `POST /sessions/agent`. The HTTP twin of the
MCP `agent_start` tool hand-destructures the request body and had omitted
`trace`, so sessions spawned via the REST driver could never opt into Langfuse
tracing even with creds configured — only the MCP path reached the registry's
traced-session gate. The route now forwards `trace` (accepting a JSON boolean or
a stringified `"true"`/`"false"`), matching `agent_start`. Same class of gap as
the earlier `orchestrator`/`mcpServers` HTTP-parity fix.
