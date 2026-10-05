---
"@agentproto/review": minor
"@agentproto/runtime": minor
"@agentproto/cli": minor
"@agentproto/apps": minor
---

feat(review): per-lane reviewer fallback. An agent check may declare `fallbackPresets: [...]` (also on a `uses[]` entry and in `uses[].overrides.<id>`); when the lane's reviewer is unavailable — spawn failure, a turn that ends in an error, an empty turn, or a session that exits early, after the per-preset retries — the lane runs on the next preset instead of settling `skipped`. Never after a verdict (a `block` is final), a timeout, a cancel, or an OpenRouter refusal; the chain shares the lane's single `timeoutMs`. The lane records the reviewer that actually ran (`preset`/`model`/`sessionId`) plus `fallbacks: [{ preset, error }]` for each unavailable one, shown in `agentproto review` output and the review panel; an exhausted chain settles the lane `skipped` listing every error.
