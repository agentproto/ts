---
"@agentproto/runtime": patch
---

A reply to a message you received is always admitted: `message_send` / `message_reply` / `POST /sessions/:id/messages` with a `replyTo` that names a message in the sender's own inbox or ledger, addressed to that message's attested sender, pass `session.message` under rule `messaging.reply` whatever the relation (verified or not, `cc:` or the shared `claude-desktop` identity). A made-up `replyTo`, or one whose original came from someone else, opens nothing. The reply is capped at steer and never interrupts.
