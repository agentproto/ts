---
"@agentproto/apps": patch
"@agentproto/runtime": patch
---

repo-maintenance `maintain` workflow: the `notify` step now sends through the operator's imported agentpush MCP (`mcp_imported_call`, `toolName: "send_message"`) instead of shelling out to `curl` via `command_execute`, removing the `bash` allowlist and `AGENTPUSH_API_KEY` requirements. A new optional `notifyAlias` input (default `agentpush`) selects the imported MCP alias, and the notification body is passed as a `send_message` arguments object.

`@agentproto/runtime` carries only a test-only change (`src/__tests__/repo-maintenance-workflow.test.ts`) — no publish-affecting source; the patch bump is included for changeset coverage completeness.
