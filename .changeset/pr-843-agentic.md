---
"@agentproto/runtime": patch
---

Add child→parent report-back communication channel: new `message_parent` MCP tool for child sessions to send messages/status updates to their parent supervisors, plus `AGENTPROTO_PARENT_SESSION_ID` environment variable for lineage discovery. Includes automatic scope injection for gateway-less children and comprehensive test coverage.
