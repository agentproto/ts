---
"@agentproto/runtime": patch
"@agentproto/cli": patch
---

Joined CI hosts stay visible after they exit: the home daemon now snapshots a joined host's sessions plus an output tail on connect and every ~15s (5s while a session runs), and serves them `stale: true` with `capturedAt` once the host is gone. A joining daemon sends a goodbye on shutdown so the home side takes a final snapshot. `online` now reflects recent successful traffic (45s grace), `lastSeen` is bumped on every successful forward (persisted throttled), and the 7-day join TTL prune also covers pre-#1542 unlabeled fingerprint-named join hosts (never `pair offer` pairings or clients).
