---
"@agentproto/sandbox-e2b": minor
---

Add list and estimated usage windows for e2b boxes. Usage is a live inventory estimate, not a billing history (a killed box drops out of the list; the fleet ledger is the record), and a paused box is counted as active through now because the SDK exposes no pause timestamp, which overestimates it.
