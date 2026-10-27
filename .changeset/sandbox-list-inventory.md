---
"@agentproto/runtime": minor
---

Add sandbox_list across every concrete provider; sandbox_gc now defaults to `computer` only (its controller scopes boxes to this daemon's tenant), and refuses an explicit e2b sweep because that shared account writes no daemon marker at boot
