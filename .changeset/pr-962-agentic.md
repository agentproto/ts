---
"@agentproto/runtime": minor
"agentproto-vscode": minor
---

Enhance session visibility by tracking watcher metadata (who's watching and what they're waiting for) alongside the watchers count. New optional `SessionWatcherInfo` type captures waiter identity, event, timeout, and attach timestamp. Adds "awaiting-bg" section for sessions with pending background tasks. All changes maintain backward compatibility.
