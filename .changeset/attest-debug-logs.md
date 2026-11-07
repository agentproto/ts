---
"@agentproto/cli": patch
"@agentproto/runtime": patch
---

Debug trail for the Claude Code session attestation: the `mcp-bridge` writes one stderr line at startup saying whether it sends `x-agentproto-claude-session` (first 8 characters of the id, or why not) and whether the URL carries `callerSessionId`; its log lines no longer print URL query values. The daemon logs one line per distinct outcome (header accepted and resolved to `cc:<id>`, header refused with the reason, header absent on a shared or anonymous connection), re-emitted at most every 10 minutes.
