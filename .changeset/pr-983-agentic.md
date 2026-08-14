---
"@agentproto/cli": minor
---

Add `agentproto sessions prompt` subcommand to message already-running sessions via the daemon's `POST /sessions/:id/prompt` endpoint. Supports fire-and-forget queuing (default), blocking mode (`--wait`), interrupt (`--interrupt`), and queue-jumping (`--force`).
