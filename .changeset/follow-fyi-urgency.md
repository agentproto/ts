---
"@agentproto/runtime": minor
---

Session follows take an optional `urgency` (`"next-turn"` default, or `"fyi"`). An `fyi` follow parks its digests in the follower's inbox without starting a turn, so a supervisor following many sessions is no longer woken for every digest. Existing follows keep `next-turn`.
