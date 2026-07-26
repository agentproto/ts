---
"@agentproto/runtime": minor
"agentproto-vscode": minor
---

Add context-continuity policy, structured checkpoints, and fresh continuation for long-running agent sessions.

- Resolve context-continuity policy (manual / ask / auto) with configurable warn/compact/continue-fresh/hard-stop thresholds.
- Build and persist bounded structured checkpoints next to the source session's events.jsonl.
- Spawn a fresh continuation session with the same adapter, model, route, access, posture, cwd, and MCP servers, linked via `continuedFrom`/`continuedTo`.
- Add MCP tools: `session_context_status`, `session_checkpoint`, `session_compact`, `session_continue_fresh`.
- Surface compact and continue-fresh actions in the VS Code sessions panel.
