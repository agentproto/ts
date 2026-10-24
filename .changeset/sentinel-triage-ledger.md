---
"@agentproto/runtime": patch
---

Record what a triage stage would decide for sentinel deliveries.

Every sentinel event that reaches a session is now classified `wake`/`fyi`/`drop`
by the fixed rules (terminal, coalesced repeat, default) and appended to an
observation-only JSONL ledger at `~/.agentproto/sentinel-triage.jsonl`
(overridable via `triagePath`). Delivery is unchanged: the sentinel's
configured urgency still applies and `applied` is always `false`. The ledger
never carries message text, event data, or a summary.
