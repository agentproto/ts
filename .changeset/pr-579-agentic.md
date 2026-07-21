---
"@agentproto/cli": patch
---

MCP bridge now auto-stamps the origin of `agent_start` calls from the client's announced name (`clientInfo.name` from the MCP `initialize` handshake). This enables bridge-routed hosts to appear as source nodes in the session tree with zero caller cooperation, resolving the "honest ceiling" described in #575. Only touches session-creating tools and never overrides explicitly-set origins.
