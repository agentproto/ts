---
"@agentproto/runtime": patch
"@agentproto/cli": patch
---

Claude Desktop can show pending approvals as Approve / Refuse cards. The `approval-cards` MCP surface is now cards-only: it serves just `approval_card_decide`, a model-visible `approval_pending` tool whose definition links the new `ui://agentproto/approval/pending` widget (one card per pending approval, each with its own one-time ticket, plus a "Nothing to approve" state) and the card resources, with none of the daemon's root tools and no deferral wrapper, so the Desktop entry does not repeat the tool list of the main `agentproto` entry. `agentproto mcp-bridge --surface approval-cards` dials that surface and keeps the query string of `AGENTPROTO_MCP_URL`, and `agentproto install-mcp --approvals` prints (with `--write`, backs up the Desktop config and adds only) an `agentproto-approvals` entry. `install-mcp --uninstall` does not remove that entry; delete the `agentproto-approvals` key from the Desktop config by hand.
