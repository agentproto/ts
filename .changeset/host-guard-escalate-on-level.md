---
"@agentproto/cli": minor
---

`agentproto host guard` escalates when the host level changes, not on every run. The last level is remembered in `~/.agentproto/host-guard/level.json` (`--level-state <path>`, `--no-level-state` to restore the per-run behaviour), and the guard escalates only when the host crosses into a level at or above `--escalate-on` (`crit` by default, or `warn`): OK→WARN, WARN→CRIT, OK→CRIT. A host that stays CRIT is escalated again after `--renotify-after <min>` (default 120, 0 = never); the same delay is the cooldown before a host that drops below a level and climbs back is escalated again for it. A WARN host found CRIT on the re-check now arms the workflow block too. A failed escalation is not recorded as sent, so the next run retries it.
