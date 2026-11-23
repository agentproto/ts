---
"@agentproto/billing": patch
---

`canPay` now counts the headroom of a lot minted with a `floor` (a bounded short position, or `null` for an unbounded one), the same bound the journal enforces on commit. Before, it summed `remaining` only, so an account the journal would let spend down to its floor read as unable to pay, and a postpaid-style lot at zero could never pass the affordability check.
