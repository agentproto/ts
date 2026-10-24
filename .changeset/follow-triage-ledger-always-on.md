---
"@agentproto/runtime": patch
---

Record follow triage decisions in the JSONL ledger while triage is disabled.

The ledger now always captures what the deterministic rules would decide for
each digest event, with `source:"follow"` and `applied:false` when triage is
off and delivery is unchanged. The operator classifier is never invoked on
the disabled path, and a rules failure cannot block the digest.
