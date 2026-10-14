---
"@agentproto/runtime": minor
"agentproto-vscode": patch
---

`session_mark_completed` accepts already-terminal sessions via the new `registry.resolveOutcome`, and the new exported `isOutcomeCompleted` makes presence and VS Code session badges treat resolved rows as completed instead of failed.
