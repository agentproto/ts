---
"@agentproto/acp": minor
"@agentproto/cli": minor
"@agentproto/runtime": minor
---

Add rawInput field propagation through permission-hold system. The tool call's raw input (e.g. Bash command string) now flows from requestPermission RPC → agent-prompt event → PendingPermission object → HTTP/MCP APIs, surfacing in the CLI `permissions ls` table as a truncated preview for enhanced transparency in permission request review.
