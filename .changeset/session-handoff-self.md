---
"@agentproto/runtime": minor
"@agentproto/harness": minor
"@agentproto/cli": minor
"@agentproto/adapter-claude-code": patch
"@agentproto/adapter-codex": patch
"@agentproto/adapter-opencode": patch
"@agentproto/adapter-copilot-cli": patch
"@agentproto/adapter-hermes": patch
---

A session can now change its own model or harness and run its own harness commands.

- New MCP tool `session_handoff` (callable on the caller itself): hands the work to another model and/or harness. The successor takes the label, parent, children, follows and the declared succession (`succeeds`); the source is closed only after the successor is confirmed running. `context` picks what travels: `handoff-summary` (default; status plus the previous session id and a `transcript_read` pointer), `harness-compact` (native `/compact`, then the model switch), `none` (model switch in place, no new session) or `full-resume` (full replay, costly, discouraged). Model policy and auth-profile allow-lists are enforced with an explicit `model_refused`.
- New MCP tool `session_command_self`: queues a harness slash-command (`/compact`, `/clear`, `/model x`, ...) on the caller's own prompt queue, run when its current turn ends. Gated by a per-harness allow-list declared in the adapter manifest (`capabilities.selfCommands`, config `acpAgents.*.self_commands`) and by the commands the harness advertises; `compactRequiresOperator` still applies.
