---
"@agentproto/runtime": patch
"@agentproto/cli": patch
---

Claude Desktop can show pending approvals as Approve / Refuse cards. On the `approval-cards` MCP surface the daemon now serves a model-visible `approval_pending` tool whose definition links the new `ui://agentproto/approval/pending` widget (one card per pending approval, each with its own one-time ticket, plus a "Nothing to approve" state); the surface is never deferred. `agentproto mcp-bridge --surface approval-cards` dials that surface and keeps the query string of `AGENTPROTO_MCP_URL`, and `agentproto install-mcp --approvals` prints (with `--write`, backs up the Desktop config and adds only) an `agentproto-approvals` entry.
