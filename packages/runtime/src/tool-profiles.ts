/**
 * Named MCP surface profiles.
 *
 * A root `/mcp` connection normally sees every daemon tool. That is the
 * right default for an operator, but it is a large context tax for clients
 * that mount `/mcp` by hand (Claude Desktop, IDEs) and cannot use the
 * spawn-side knobs. A profile narrows that surface to a named allowlist,
 * composed with `?profile=core,apps` on `/mcp` or `defaults.mcp.profile`
 * in `~/.agentproto/config.json`.
 *
 * `full` is the default when neither source names a profile, so existing
 * callers keep exactly the surface they had before. Profiles only ever
 * REMOVE tools from `tools/list` / registration; `tool_help` still reads
 * docs for tools outside the active profile (see `profilesExposingTool`).
 *
 * The per-request `?allowTools=` / `?denyTools=` filters still apply on top:
 * `denyTools` wins over a profile, and `allowTools` intersects with one.
 */

import { DAEMON_TOOL_NAMES } from "./daemon-tool-names.generated.js"
import { DEFAULT_ORCHESTRATOR_TOOLS } from "./orchestrator-gateway.js"

export const TOOL_PROFILE_NAMES = [
  "core",
  "orchestrator",
  "apps",
  "admin",
  "full",
] as const

export type ToolProfileName = (typeof TOOL_PROFILE_NAMES)[number]

/** `withToolSubset` honours a trailing `*` as a prefix match. The only
 *  wildcard in a profile is the dynamic MCP Apps panel family, whose tool
 *  ids are `app_ui_<slug>` per installed app and therefore unknowable from
 *  a static list. */
export const APP_UI_TOOL_PREFIX = "app_ui_"
export const APP_UI_TOOL_WILDCARD = `${APP_UI_TOOL_PREFIX}*`

/**
 * The everyday working set: drive agents, read sessions, exchange messages,
 * use policies/tasks/memory, touch files and commands, call imported MCP
 * servers, inspect/run apps, and open a PR.
 *
 * Deliberately trimmed to 45 from the wider list in the design note:
 * `policy_ack` (host-side acknowledgement, not an agent loop step),
 * `file_info` (read/write cover the common path), `memory_read` (search
 * already returns matching content), `terminal_kill` and
 * `terminal_sessions_list` (terminal_input/output/start cover the loop and
 * `session_list` finds the session) stay on the wider admin/full surface.
 */
export const CORE_PROFILE_TOOLS: readonly string[] = [
  // Agent lifecycle + prompting.
  "agent_start",
  "agent_prompt",
  "agent_output",
  "agent_kill",
  "agent_interrupt",
  // Session observation and event fan-in.
  "session_list",
  "session_tree",
  "session_transcript",
  "session_context_status",
  "session_monitor",
  "session_events_poll",
  // Typed session messaging.
  "message_parent",
  "message_reply",
  "message_send",
  // Receive side of the messaging loop.
  "inbox_ack",
  "inbox_list",
  "inbox_wait",
  // Policy attachment/observation used by task and completion gates.
  "policy_attach",
  "policy_cancel",
  "policy_list",
  "policy_status",
  // Shared task ledger.
  "task_claim",
  "task_create",
  "task_list",
  "task_update",
  // Long-form docs remain reachable from a narrow surface.
  "tool_help",
  // Durable memory lookup and write.
  "memory_search",
  "memory_write",
  // Workspace filesystem essentials.
  "file_delete",
  "file_read",
  "file_write",
  "directory_list",
  // Shell execution and command discovery.
  "command_execute",
  "command_list",
  // Interactive terminal loop.
  "terminal_input",
  "terminal_output",
  "terminal_start",
  // Git worktree status for isolated spawns.
  "worktree_status",
  // Imported third-party MCP servers: call, enumerate servers, enumerate tools.
  "mcp_imported_call",
  "mcp_imported_list",
  "mcp_imported_tool_list",
  // Installed apps: discover, run, inspect.
  "app_list",
  "app_run",
  "app_status",
  // Open a pull request.
  "pr_open",
]

/** `app_*` daemon tools plus the dynamic `app_ui_<slug>` panel tools. */
export const APPS_PROFILE_TOOLS: readonly string[] = [
  "app_apply",
  "app_artifact_get",
  "app_call",
  "app_catalog",
  "app_data_list",
  "app_data_migrate",
  "app_data_read",
  "app_data_write",
  "app_external_list",
  "app_external_read",
  "app_install",
  "app_link_mint",
  "app_list",
  "app_list_applied",
  "app_resync",
  "app_run",
  "app_session_events",
  "app_session_tree",
  "app_skill_get",
  "app_state_append",
  "app_state_get",
  "app_state_list",
  "app_status",
  "app_stop",
  "app_tool_call",
  "app_tunnel",
  "app_unapply",
  "app_uninstall",
  "app_updates",
]

/**
 * Operator/admin surface: setup and pairing, tunnels, remote access,
 * auth profiles, device/join-token management, messaging integrations,
 * garbage collection, presets/bundles, inbound watchers, sentinels, cron,
 * and local LLM endpoints.
 */
export const ADMIN_PROFILE_TOOLS: readonly string[] = [
  "adapter_install",
  "harness_install",
  "auth_profile_create",
  "auth_profile_delete",
  "auth_profile_import",
  "auth_profile_list",
  "auth_profile_refresh_models",
  "auth_profile_set_enabled",
  "auth_profile_set_models",
  "auth_profile_update",
  "branch_gc",
  "branch_gc_restore",
  "branch_gc_review_worktree",
  "branch_gc_status",
  "branch_gc_verdict",
  "branch_gc_verdict_get",
  "bundle_create",
  "bundle_delete",
  "bundle_list",
  "bundle_update",
  "config_set",
  "cron_create",
  "cron_delete",
  "cron_list",
  "cron_run",
  "cron_runs",
  "cron_update",
  "device_add",
  "device_list",
  "device_prompt",
  "device_rename",
  "device_revoke",
  "device_sessions",
  "harness_preset_create",
  "harness_preset_delete",
  "harness_preset_list",
  "harness_preset_set_default",
  "inbound_endpoint_create",
  "inbound_endpoint_delete",
  "inbound_endpoint_list",
  "inbound_watcher_list",
  "inbound_watcher_start",
  "inbound_watcher_stop",
  "join_token_create",
  "join_token_list",
  "join_token_revoke",
  "llm_endpoint_list_links",
  "llm_endpoint_set_upstream_link",
  "llm_endpoint_start",
  "llm_endpoint_status",
  "llm_endpoint_stop",
  "pair_confirm",
  "pair_decline",
  "pair_list",
  "pair_offer",
  "pair_pending",
  "pair_revoke",
  "remote_disable",
  "remote_enable",
  "remote_status",
  "sandbox_checkpoint_gc",
  "sandbox_checkpoint_gc_status",
  "sandbox_gc",
  "sentinel_list",
  "sentinel_poll_now",
  "sentinel_routes",
  "sentinel_unwatch",
  "sentinel_watch",
  "session_gc",
  "setup_eval_reporter",
  "setup_sandbox_provider",
  "setup_sentinel_provider",
  "setup_tunnel_provider",
  "telegram_bot_set_webhook",
  "telegram_bot_token_set",
  "telegram_bot_token_status",
  "tunnel_add_hostname",
  "tunnel_create",
  "tunnel_delete",
  "tunnel_list",
  "tunnel_login",
  "tunnel_remove_hostname",
  "tunnel_revoke",
  "tunnel_status",
  "tunnel_stop",
  "user_preset_delete",
  "user_preset_list",
  "user_preset_resolve",
  "user_preset_save",
  "worktree_gc",
  "worktree_gc_status",
]

/** Named profile members. `full` is handled separately (everything). */
export const PROFILE_TOOLS: Record<Exclude<ToolProfileName, "full">, readonly string[]> = {
  core: CORE_PROFILE_TOOLS,
  orchestrator: DEFAULT_ORCHESTRATOR_TOOLS,
  apps: [...APPS_PROFILE_TOOLS, APP_UI_TOOL_WILDCARD],
  admin: ADMIN_PROFILE_TOOLS,
}

/**
 * Tools that exist on the daemon but intentionally belong only to `full`.
 *
 * This list is explicit, not derived from `DAEMON_TOOL_NAMES`: the budget
 * test requires every generated name to be classified here or in a named
 * profile, so adding a new daemon tool fails until its author decides where
 * it belongs.
 */
export const FULL_ONLY_TOOLS: readonly string[] = [
  "activities_list",
  "adapter_list",
  "adapter_models",
  "harness_list",
  "harness_models",
  "agent_export",
  "agent_sessions_list",
  "agent_set_effort",
  "agent_set_model",
  "agent_set_operator_label",
  "agent_set_posture",
  "agent_set_prompt_policy",
  "agentproto_agents_overview",
  "agentproto_bureau_sessions",
  "agentproto_reviews",
  "agentproto_session_chat",
  "agentproto_session_story",
  "agentproto_sessions",
  "agentproto_store",
  "agentproto_work_board",
  "approval_consume",
  "approval_get",
  "approval_request",
  "approval_wait",
  "auth_discover_credentials",
  "browser_click",
  "browser_evaluate",
  "browser_extract_text",
  "browser_fill",
  "browser_get_dom",
  "browser_list_tabs",
  "browser_navigate",
  "browser_press_key",
  "browser_screencast_frame",
  "browser_screencast_start",
  "browser_screencast_stop",
  "browser_screenshot",
  "browser_scroll",
  "capabilities_inventory",
  "catalog_diff",
  "catalog_models",
  "catalog_provider_models",
  "command_log_tail",
  "config_get",
  "conversation_export",
  "conversation_locate",
  "conversation_read",
  "create_agent",
  "create_tool",
  "daemon_health",
  "decision_collect_evidence",
  "decision_decide",
  "decision_run_review",
  "decision_select_review",
  "decision_stage_classify",
  "decision_stage_escalate",
  "decision_stage_rules",
  "decision_validate_verdict",
  "delete_tool",
  "directory_create",
  "fetch_page",
  "file_info",
  "harness_capabilities",
  "host_load",
  "list_browsers",
  "list_eval_reporters",
  "list_provider_presets",
  "list_sandbox_providers",
  "list_sentinel_adapters",
  "list_tunnel_adapters",
  "live_session",
  "mcp_app_tool_call",
  "mcp_app_ui_index",
  "mcp_app_ui_read",
  "mcp_discovered_list",
  "mcp_import",
  "mcp_imported_remove",
  "mcp_imported_status",
  "memory_archive",
  "memory_dismiss",
  "memory_list",
  "memory_read",
  "memory_supersede",
  "model_list_delete",
  "model_list_list",
  "model_list_resolve",
  "model_list_save",
  "model_roles",
  "permissions_explain",
  "policy_ack",
  "quota_status",
  "review_cancel",
  "review_export",
  "review_ledger",
  "review_pr",
  "review_run",
  "review_status",
  "role_list",
  "routine_list",
  "routine_reconcile",
  "routine_trigger",
  "run_events",
  "run_request_input",
  "sandbox_attach",
  "sandbox_egress_health",
  "sandbox_exec",
  "sandbox_list",
  "self_inspect",
  "session_adopt",
  "session_archive",
  "session_artifact_add",
  "session_artifact_get",
  "session_artifact_list",
  "session_artifact_pin",
  "session_bg_task_tail",
  "session_capabilities",
  "session_checkpoint",
  "session_compact",
  "session_continue_fresh",
  "session_continue_interrupted",
  "session_evidence",
  "session_flag_status",
  "session_follow",
  "session_follows",
  "session_judge_jev",
  "session_labels",
  "session_mark_completed",
  "session_migrate",
  "session_queue_deliver",
  "session_queue_drop",
  "session_queue_list",
  "session_queue_promote",
  "session_recap",
  "session_rename",
  "session_reorder_pinned",
  "session_restart",
  "session_role_refresh",
  "session_role_watch",
  "session_search",
  "session_set_keepalive",
  "session_set_pinned",
  "session_stats",
  "session_unarchive",
  "session_unfollow",
  "session_usage",
  "session_wrapup_apply",
  "session_wrapup_plan",
  "session_wrapup_status",
  "sessions_report",
  "skill_import",
  "skill_imported_list",
  "skill_imported_remove",
  "skill_resync",
  "summarize_session",
  "terminal_kill",
  "terminal_sessions_list",
  "tool_calls_list",
  "transcript_read",
  "transcript_search",
  "transmit_message",
  "usage_rollup",
  "workflow_artifact_get",
  "workflow_cancel",
  "workflow_escalation_resolve",
  "workflow_list",
  "workflow_publish",
  "workflow_retry",
  "workflow_run_file",
  "workflow_start",
  "workflow_status",
  "workspace_brain_ingest",
  "workspace_brain_query",
  "workspace_brain_status",
]

/**
 * Every name a profile can classify. `full` is deliberately absent: it
 * contains everything by definition, so it cannot tell an author where a
 * new tool should go.
 */
export const CLASSIFIED_TOOL_NAMES: ReadonlySet<string> = new Set([
  ...CORE_PROFILE_TOOLS,
  ...DEFAULT_ORCHESTRATOR_TOOLS,
  ...APPS_PROFILE_TOOLS,
  ...ADMIN_PROFILE_TOOLS,
  ...FULL_ONLY_TOOLS,
])

export function isToolProfileName(value: string): value is ToolProfileName {
  return (TOOL_PROFILE_NAMES as readonly string[]).includes(value)
}

/** Split a comma-separated `?profile=` / config value into known names.
 *  Duplicates collapse; unknown names are ignored, and a value with no
 *  known name falls back to `undefined` (the full surface). */
export function parseToolProfileList(
  raw: string | readonly string[] | undefined,
): ToolProfileName[] | undefined {
  if (raw === undefined) return undefined
  const tokens = (typeof raw === "string" ? raw.split(",") : raw)
    .map(value => value.trim())
    .filter(Boolean)
  const out: ToolProfileName[] = []
  for (const token of tokens) {
    if (!isToolProfileName(token) || out.includes(token)) continue
    out.push(token)
  }
  return out.length > 0 ? out : undefined
}

/**
 * The per-request query wins over the boot-time config default when it names
 * at least one known profile. An absent / unusable query falls through to
 * the config, and an absent / unusable config means `full`.
 */
export function resolveToolProfileSelection(input: {
  query?: string | readonly string[]
  config?: string | readonly string[]
}): ToolProfileName[] | undefined {
  const query = parseToolProfileList(input.query)
  if (query) return query
  return parseToolProfileList(input.config)
}

/** Tools exposed under every named profile, whatever its list says. */
export const ALWAYS_ON_TOOLS: readonly string[] = ["tool_help"]

/** A name belongs to `full` if it is any daemon tool or a dynamic app UI. */
function isExposedByFull(name: string): boolean {
  return name.startsWith(APP_UI_TOOL_PREFIX) || (DAEMON_TOOL_NAMES as readonly string[]).includes(name)
}

/**
 * The allow set to pass to `withToolSubset`, or `undefined` when the
 * surface should stay unrestricted (`full`, or no profile named at all).
 */
export function resolveToolProfileAllowSet(
  profiles: readonly ToolProfileName[] | undefined,
): ReadonlySet<string> | undefined {
  if (!profiles || profiles.length === 0 || profiles.includes("full")) return undefined
  const names = new Set<string>(ALWAYS_ON_TOOLS)
  for (const profile of profiles) {
    if (profile === "full") return undefined
    for (const name of PROFILE_TOOLS[profile]) names.add(name)
  }
  return names
}

/**
 * Which profiles expose a tool, for `tool_help` when the tool is outside the
 * active profile. `full` is included for every real daemon tool; dynamic
 * `app_ui_<slug>` panels are exposed by `apps` and `full`.
 */
export function profilesExposingTool(name: string): ToolProfileName[] {
  const profiles: ToolProfileName[] = []
  if (name.startsWith(APP_UI_TOOL_PREFIX)) profiles.push("apps")
  const alwaysOn = ALWAYS_ON_TOOLS.includes(name)
  for (const profile of ["core", "orchestrator", "apps", "admin"] as const) {
    if ((alwaysOn || PROFILE_TOOLS[profile].includes(name)) && !profiles.includes(profile)) {
      profiles.push(profile)
    }
  }
  if (isExposedByFull(name)) profiles.push("full")
  return profiles
}
