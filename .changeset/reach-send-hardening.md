---
"@agentproto/runtime": patch
---

`reach_send` is hardened. The daily cap of 20 now counts every call that reached the route, not only acknowledged tells, and calls of one session are serialized so concurrent tells cannot overshoot it. `tells.jsonl` is compacted to the 24 h window on its first load of a run. An unknown `via` answers `invalid_input`. `"now"` is no longer in the tool's `urgency` schema (the runtime refusal stays). Link URLs are limited to 500 characters and the rendered text to 4000. The tells directory honours `AGENTPROTO_HOME`. The REACH watchdog no longer re-reports, after a restart, an approval whose `reach.json` already holds a terminal `undelivered` watchdog receipt.
