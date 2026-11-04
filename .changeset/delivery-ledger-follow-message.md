---
"@agentproto/runtime": minor
---

Record follow and message deliveries in the shared append-only delivery ledger.

- `@agentproto/runtime`: follow digests append one `producer: "follow"` line per entry after the digest outcome, with a deterministic event id, the contributing follow id (or `follower:<id>`), the must-wake `floor`, triage `level` / `rule` / `repeatKey`, and the digest `messageId` for delivered entries. The parent relay and `POST /sessions/:id/messages` append one `producer: "message"` line after the send outcome, with `eventId`/`messageId` set to the envelope id, the sender as `subject`, and the level derived from urgency. A ledger write failure never changes the response. `follow-triage.jsonl` is no longer written; delivery behaviour is unchanged.
