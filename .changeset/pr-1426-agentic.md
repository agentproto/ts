---
"@agentproto/runtime": minor
"@agentproto/cli": minor
"@agentproto/apps": patch
"agentproto-desktop": patch
---

Durable inter-session messaging inbox (AIP-46 §Session messages): new `message_send`, `message_reply`, `inbox_list`, `inbox_ack`, `inbox_wait` tools, `POST /sessions/:id/messages` / `GET /sessions/:id/inbox` / `POST /sessions/:id/inbox/ack` HTTP routes, `sessions inbox` / `sessions message` CLI commands, and a re-routed `message_parent` through `registry.sendMessage`.
