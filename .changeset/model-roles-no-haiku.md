---
"@agentproto/runtime": patch
"@agentproto/apps": patch
---

Model roles no longer default to Haiku: `review.small` and `judge.session` now default to `claude-sonnet-5-5`, and `review.large` (and the retry reviewer) to `claude-opus-5-5`. Override any role via `models` in `agentproto.json` / the daemon config as before.
