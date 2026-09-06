---
"@agentproto/runtime": minor
---

Complete ToolTransformer migration of remaining list tools: 25+ tools across agent-tools (agent_sessions_list, adapter_list, catalog_models, catalog_provider_models, role_list), app-tools (tunnel_list, app_list, app_list_applied, task_list, app_data_list, app_external_list), session-tools (terminal_sessions_list, command_list, mcp_discovered_list, mcp_imported_list, mcp_imported_tool_list, session_queue_list, worktree_status), and orchestration tiers (inbound_watcher_list, inbound_endpoint_list, cron_list). All tools now COMPACT BY DEFAULT with real per-item projections; `full: true` / `compact: false` restores verbose records. Pagination, field filtering, and consistent error handling via the shared paginated()/catchErrors() transformers. Legacy envelope shapes preserved for backward compatibility.
