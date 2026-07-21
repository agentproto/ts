---
"agentproto-vscode": minor
---

Add `agentproto.setSessionAccessProfile` command to change which auth profile (wallet) an agent-cli session bills against. Access is a restart-only axis per SPEC §4.3, so the command drives `session_restart` with an `access` override. Includes proper handling of live sessions (kill-first to avoid duplicates) and profile eligibility filtering reusing the sessionConfig resolver.
