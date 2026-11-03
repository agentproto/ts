---
"@agentproto/delivery": minor
"@agentproto/sentinel": minor
"@agentproto/runtime": minor
---

Add the append-only delivery ledger and record all three producers into it.

- `@agentproto/delivery`: pure `LedgerLine` / `LedgerProducer` / `LedgerOutcome` types in the root entry, plus an opt-in `@agentproto/delivery/ledger-writer` subpath that appends one JSON line per delivery decision. The writer never throws and creates its parent directory with mode `0600`; the root entry stays I/O free.
- `@agentproto/sentinel`: each delivered sentinel event appends one ledger line after the outcome is known (`delivered`, `queued`, `inbox`, `retargeted`, `parked`, `dropped`, or `duplicate`), carrying the triage `level`, `rule`, `repeatKey` and the message id. `sentinel-triage.jsonl` is no longer written; existing files are left in place. Delivery behaviour is unchanged.
- `@agentproto/runtime`: follow digests append one `producer: "follow"` line per entry after the digest outcome, with a deterministic event id, the contributing follow id (or `follower:<id>`), the must-wake `floor`, triage `level` / `rule` / `repeatKey`, and the digest `messageId` for delivered entries. The parent relay and `POST /sessions/:id/messages` append one `producer: "message"` line after the send outcome, with `eventId`/`messageId` set to the envelope id, the sender as `subject`, and the level derived from urgency. A ledger write failure never changes the response. `follow-triage.jsonl` is no longer written; delivery behaviour is unchanged.
