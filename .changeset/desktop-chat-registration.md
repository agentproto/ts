---
"@agentproto/runtime": minor
"@agentproto/cli": minor
---

Register Claude Desktop chats as external sessions so their per-chat inbox works: runtime gains a trusted `POST /sessions/:id/touch` plus percent-encoded id decoding on the inbox/message routes, and the cli `hook inbox` registers `cc:<session_id>` before its GET while `hook install` drops the legacy `AGENTPROTO_SESSION_ID` env.
