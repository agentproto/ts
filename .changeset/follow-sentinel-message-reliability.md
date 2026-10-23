---
"@agentproto/runtime": patch
---

Harden blocker delivery, inbox eviction, and follow/sentinel lifetimes.

- `blocker` and `question` messages are never downgraded to `fyi`: an
  explicit `fyi` is applied as `next-turn`, so the recipient wakes (or the
  message parks with the inbox's non-loss guarantee).
- A full inbox now evicts noise (`notice`/`fyi`) first and never drops an
  un-consumed `blocker`/`question`. When every entry is protected, a new
  noisy message is refused instead; a new protected message may exceed the
  soft cap rather than lose a blocker.
- Follows and sentinels now carry an `expiresAt` (defaulted to 7 days,
  matching the cron scheduler's owned-job backstop) and a periodic wiring
  sweep removes expired records and those whose recipient is gone or retired
  (relinking to a live successor when one exists). The sweep runs at boot and
  every 60 seconds, cleaning up orphans left by an older daemon.
