---
"@agentproto/runtime": minor
"@agentproto/cli": minor
---

Register Claude Desktop chats as external sessions so their per-chat inbox works.

- `@agentproto/runtime`: new trusted `POST /sessions/:id/touch` route (403 unless loopback or daemon bearer) registers or refreshes an `external` row with `host`, `name`, `cwd` and `hostSessionId`; daemon-owned rows are never adopted. `SessionDescriptor` gains `externalHostSessionId`, and `/sessions/:id/{messages,inbox,inbox/ack}` now decode percent-encoded ids so `cc:<id>` reaches its row.
- `@agentproto/cli`: `hook inbox` touches `cc:<session_id>` before the inbox GET (host `claude-desktop`, name and hostSessionId from `sessions/*.json`, cwd from the payload); a failed touch never breaks the hook. `hook install --host claude-desktop` stops writing `env.AGENTPROTO_SESSION_ID` and removes a legacy `claude-desktop` value.
