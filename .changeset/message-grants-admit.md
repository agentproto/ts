---
"@agentproto/runtime": minor
---

A `session:message` grant written under the new `defaults.messaging.grants` now admits a send between two sessions the tree and the switches would refuse (relation `granted`), evaluated by the same `decide()` for `message_send`, `message_reply` and `POST /sessions/:id/messages`. With no grants configured nothing changes.
