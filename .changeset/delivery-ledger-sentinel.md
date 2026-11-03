---
"@agentproto/delivery": minor
"@agentproto/sentinel": minor
---

Add the append-only delivery ledger schema and writer, and make the sentinel record into it.

- `@agentproto/delivery`: pure `LedgerLine` / `LedgerProducer` / `LedgerOutcome` types in the root entry, plus an opt-in `@agentproto/delivery/ledger-writer` subpath that appends one JSON line per delivery decision. The writer never throws and creates its parent directory with mode `0600`; the root entry stays I/O free.
- `@agentproto/sentinel`: each delivered sentinel event appends one ledger line after the outcome is known (`delivered`, `queued`, `inbox`, `retargeted`, `parked`, `dropped`, or `duplicate`), carrying the triage `level`, `rule`, `repeatKey` and the message id. `sentinel-triage.jsonl` is no longer written; existing files are left in place. Delivery behaviour is unchanged.
