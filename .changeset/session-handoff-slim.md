---
"@agentproto/runtime": patch
"@agentproto/adapter-claude-code": patch
"@agentproto/adapter-codex": patch
"@agentproto/adapter-opencode": patch
"@agentproto/adapter-copilot-cli": patch
"@agentproto/adapter-hermes": patch
"@agentproto/cli": patch
---

Slim `session_handoff`: no `full-resume` mode, the new-session case reuses `session_continue_fresh`'s path, and every continuation prompt now points at `transcript_read` for the previous session. `harness-compact` is source-less for an operator call (honours `compactRequiresOperator`) and refuses when the harness doesn't advertise the compact command; a self-handoff reports `sourceClosePending`. Adapter manifests declare only the confirmed `selfCommands` (`compact`; hermes `compress`, `model`).
