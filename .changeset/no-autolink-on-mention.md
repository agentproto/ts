---
"@agentproto/runtime": patch
---

A session no longer becomes the sentinel owner of a PR it merely mentions: PRs found by the reconciler's output-scan lane are recorded for provenance but never auto-watched. The auto-watch delivery urgency is now configurable via `config.sentinel.autoWatchUrgency` (default `next-turn`).
