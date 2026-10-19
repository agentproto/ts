---
"@agentproto/computer-api": minor
"@agentproto/sandbox-computer": minor
---

`computer` sandbox provider: attach and detach can carry a stable session holder. `config.sessionHolder` (fallback `AGENTPROTO_SESSION_ID`) is sent as the optional `holder` body on attach and detach, and in `daemonRoute` mode every relayed HTTP/WebSocket request carries `X-Computer-Session-Holder`. A controller that tracks holders treats a re-attach by the same holder as idempotent, so a restarted daemon re-attaches onto the slot its dead predecessor held instead of hitting the 409 session limit. `@agentproto/computer-api` adds the exported `attachRequestSchema` and `AttachRequest` type for the optional body; `@agentproto/sandbox-computer` adds the optional `sessionHolder` config and optional `holder` arguments on the controller client's `attach`/`detach`.
