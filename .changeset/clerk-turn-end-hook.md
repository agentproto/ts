---
"@agentproto/runtime": minor
---

AIP-68 clerk hook: a daemon subscriber (`clerk-turn-end`) that runs ONE clerk pass (steward/secretary) after a session's turn ends. The pass is debounced on the session's idle time (10 minutes by default, AIP-68 §3.6), single-flight per session (never two passes on one session at once) and fire-and-forget (the turn is never blocked or slowed). The hook is DISABLED by default and ignores its own sessions, empty turns, interrupted turns and excluded sessions.

Configuration has three levels, most specific wins (merged per field): the daemon default (`~/.agentproto/config.json` → `daemon.clerk`, disabled), the workspace (`.agentproto/hooks.json` → `hooks.clerk`, the PR #2142 `hooks.enabled` / `on: "turn_end"` vocabulary), and the agent (its manifest's `metadata.hooks.clerk`, or an `agent_start` option's `hooks.clerk`). Fields: `enabled`, `on`, `debounceMs`, `run` (a routine id or a shell command) and `exclude`.
