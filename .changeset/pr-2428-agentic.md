---
"@agentproto/runtime": minor
---

Add explicit `defaults.messaging.grants`: AIP-38 `session:message` grants that may admit a send between two sessions the messaging tree and switches refuse (relation `granted`), evaluated by the same `decide()` for `message_send`, `message_reply`, `POST /sessions/:id/messages` and `permissions_explain`. A matching deny still wins and tree edges, the operator and the system are unaffected; with no grants configured nothing changes. `GET /permissions/grants` now also returns the configured grants under `configured`.
