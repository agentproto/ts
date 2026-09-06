---
"@agentproto/runtime": patch
---

Fix backward compatibility for legacy persisted supervisor state that predates the fan-in (WP6) feature. Daemon reloads with old policies lacking `sessionIds` and `pending` fields now normalize gracefully instead of crashing. Additionally, per-owner projection errors are now caught and logged, preventing a single malformed owner from taking down the entire Activity read-model.
