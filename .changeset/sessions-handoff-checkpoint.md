---
"@agentproto/runtime": minor
"@agentproto/cli": minor
---

Add `POST /sessions/:id/checkpoint` and `POST /sessions/:id/handoff` HTTP routes, and the matching `agentproto sessions checkpoint` / `agentproto sessions handoff` CLI verbs. `handoff` writes a context-continuity checkpoint for a session and starts a new session on a different harness (e.g. claude-code → codex) whose first prompt is that checkpoint, linking the two sessions via `continuedTo`/`continuedFrom`. `--dry-run` (CLI) / `dryRun` (HTTP body) previews the checkpoint and resume prompt without writing a file or spawning anything.
