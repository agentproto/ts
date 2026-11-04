---
"@agentproto/delivery": minor
"@agentproto/runtime": patch
"@agentproto/sentinel": minor
---

Add per-target batching to the delivery kernel. A sentinel target can set
`batchMs`; a burst of envelopes for the same session inside that window is
delivered as one message, so the session starts one turn instead of one per
envelope. The ledger still records one line per envelope and target, and the
sentinel triage level / rule for each event is unchanged. The sentinel default
is `batchMs: 0`, which keeps the existing one-delivery-per-envelope behaviour.
