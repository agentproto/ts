---
"@agentproto/runtime": minor
---

Additive limit/cursor pagination for the app/task/misc list tools: task_list, app_list, app_list_applied, app_data_list, app_external_list, role_list, adapter_list (plus a `full:true` alias for `summary:false`), auth_profile_list, harness_preset_list, browser_adapter_list, list_browsers, llm_endpoint_list_links, tunnel_list, worktree_status, session_queue_list, mcp_imported_list, mcp_discovered_list. Calls without limit/cursor are byte-identical to before.
