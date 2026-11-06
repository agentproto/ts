---
"@agentproto/runtime": patch
---

With `delivery.apply.types["message.*"]` on (default off), a `message_send` / `message_reply` / `POST /sessions/:id/messages` aimed at a dead session (killed, exited, error, a lapsed `cc:` row) is delivered to its live parent instead, with a `[for <recipient id>] ` prefix on the text. The ledger line records `applied: true`, `outcome: "retargeted"` and `routedTo` (the parent). The route is taken only when the sender may message the parent directly; a superseded recipient, no parent, or a dead parent keep today's refusal. Flag off changes nothing.
