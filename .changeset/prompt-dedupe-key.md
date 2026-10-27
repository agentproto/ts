---
"@agentproto/runtime": minor
---

Add a persisted, bounded `dedupeKey` to prompt admission so a retried prompt is delivered at most once inside a 24 hour window.
