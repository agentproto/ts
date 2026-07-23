---
"@agentproto/runtime": minor
---

Add argv-level allowlist matching and callerSessionId provenance threading for command_execute.

Allowlist entries can now constrain command arguments (e.g., allow `git status` but deny `git push`), while plain string entries remain unconstrained for backward compatibility. Session ID pre-minting enables tracking which agent session invoked a command through the MCP gateway.
