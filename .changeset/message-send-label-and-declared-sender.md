---
"@agentproto/runtime": patch
"@agentproto/cli": patch
---

`message_send` accepts `to: "label:<label>"`, which resolves to the single live session carrying that operator-assigned label (no live match is `no_live_session_for_label`, several is `ambiguous_label`; the permission check runs on the resolved session). It also takes `declaredSender: "cc:<session_id>"` from the shared unverified `claude-desktop` identity only, so the recipient sees `[declared sender: cc:<id>, unverified]` with a reply address; it raises no trust and a call with a session identity is refused. The inbox hook text shows the declared sender.
