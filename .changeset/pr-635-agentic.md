---
"@agentproto/runtime": minor
---

Implement interrupted-turn contract (§4) for daemon-restart session recovery. Sessions that die with a turn in flight are now marked with a derived `interrupted` field and resumed without auto-retrying the dropped prompt. A new `SessionResumedEvent` bus event surfaces recovery state to watchers, and a new `isResumable()` predicate gates in-place resumption eligibility. Also fixes an ordering regression (§5) where completion policies were silently cancelled at boot when their watched session recovered under a daemon restart.
