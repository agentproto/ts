---
"@agentproto/sandbox-e2b": minor
---

Add list and estimated usage windows for e2b boxes. Usage is a live inventory estimate, not a billing history (a killed box drops out of the list; the fleet ledger is the record). Paused boxes are listed for inventory/gc but excluded from usage, since e2b stops billing them once paused.
