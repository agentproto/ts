---
"@agentproto/runtime": patch
---

REACH router follow-ups. A `deferred` receipt whose `until` has already passed now counts as `undelivered(deferred-past-due)` and the route goes on to the next adapter, the same way a `deferred` past the approval's expiry already did. The owner's route is built once at boot, and the router starts only when at least one adapter can deliver. A route with only a `telegram` entry, on a daemon without Telegram approval cards, starts no router and logs one `reach:` warning explaining why, and approvals are announced as they are without `reach`. The router's adapter errors are logged with a `reach:` prefix.
