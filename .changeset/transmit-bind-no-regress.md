---
"@agentproto/runtime": patch
---

`transmit_message` no longer re-points a contact binding from a revived session back to its dead ancestor. A revived session keeps quoting its ancestor's id, so each reply used to reset the binding to the dead session and the next inbound message resurrected yet another copy. An ancestor id (via `continuedFrom`) now never overrides a binding already on its descendant.
