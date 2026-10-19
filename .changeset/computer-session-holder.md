---
"@agentproto/computer-api": patch
"@agentproto/sandbox-computer": patch
---

`computer` sandbox provider: attach and detach can carry a stable session holder. `config.sessionHolder` (fallback `AGENTPROTO_SESSION_ID`) is sent as the optional `holder` body on attach and detach; a controller that tracks holders then treats a re-attach by the same holder as idempotent, so a restarted daemon no longer hits the 409 session limit against the slot its dead predecessor still held. In `daemonRoute` mode every relayed request (HTTP and WebSocket) also carries the holder as `X-Computer-Session-Holder`, so a controller proxy can attribute the activity to the right session slot. `@agentproto/computer-api` documents the optional body as `attachRequestSchema`.
