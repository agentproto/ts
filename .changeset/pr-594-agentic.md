---
"@agentproto/runtime": minor
---

Add provenance tracking for command sessions via `origin` and `callerSessionId` fields.

- `SessionDescriptor` now includes optional `origin` (source label: "command_execute", "cron", etc.) and `callerSessionId` (session that invoked this one)
- `command_execute` tool accepts optional `origin` parameter, defaults to "command_execute"
- Cron scheduler stamps `origin: "cron"` on scheduled command sessions
- Transcript export includes provenance fields in metadata and renders them in markdown output
- All changes backward compatible; fields are optional and only set when provided
