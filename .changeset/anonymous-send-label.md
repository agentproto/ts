---
"@agentproto/runtime": minor
---

New `defaults.messaging.anonymousSend` (`"label"` default, `"block"`), hot-read per call. With `label`, `message_send` / `message_reply` and `POST /sessions/:id/messages` no longer refuse an anonymous or unverified sender (an identity-less MCP client, or the shared `claude-desktop` Chat-tab identity) with `forbidden_recipient`: the message reaches any live session, its text is prefixed `[unverified sender: <label>] `, and delivery is capped at `steer` (an `interrupt` request degrades to `steer`). `block` restores the previous refusal. Verified senders and `agent_prompt` rules are unchanged.
