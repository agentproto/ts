---
"@agentproto/runtime": patch
---

Record follow-triage rule verdicts to the triage ledger for every session-follow event even when triage is disabled. Ledger lines now include `source: "follow"` and `applied: false` in that mode; digest text, urgency, and delivery are unchanged.
