---
"@agentproto/runtime": minor
---

Record follow and message deliveries in the shared append-only delivery ledger.

- `session-follow`: one `producer: "follow"` line per digest entry, written after the digest's delivery outcome is known. Entries carry a deterministic event id, the contributing follow id (or `follower:<id>`), the must-wake `floor`, the triage `level` / `rule` / `repeatKey`, and the digest `messageId` for delivered entries. `follow-triage.jsonl` is no longer written; existing files stay for history, and delivery behaviour is unchanged.
- parent relay and `POST /sessions/:id/messages`: one `producer: "message"` line after the send outcome, with `eventId`/`messageId` set to the envelope id, the sender as `subject`, and the level derived from urgency. A ledger write failure never changes the response.
- `@agentproto/runtime` now depends on `@agentproto/delivery` for the pure ledger types and the writer subpath.
