/**
 * Maps our workspace/daemon tool ids onto Mastra AgentController's
 * {@link ToolCategory}, and declares the default per-category approval
 * policy.
 *
 * `ToolCategory` (installed @mastra/core 1.57.0) is a closed union:
 * `'read' | 'edit' | 'execute' | 'mcp' | 'other'` — narrower than the plan's
 * read/write/execute/spawn shape. The mapping between the two:
 *   - plan "write"  → Mastra "edit"
 *   - plan "spawn"  → Mastra "mcp"
 * Any tool id this resolver doesn't recognize returns `null`, which the
 * controller treats as category `'other'`.
 */

import type { PermissionRules, ToolCategory } from "@mastra/core/agent-controller"

const CATEGORY_BY_TOOL: Record<string, ToolCategory> = {
  list_dir: "read",
  read_file: "read",
  read_diff: "read",
  write_file: "edit",
  edit_file: "edit",
  apply_patch: "edit",
  run_command: "execute",
  run_tests: "execute",
  // Daemon verbs (WP-5) — spawning/prompting/reading a sibling session is the
  // same "reach outside this run" shape as an MCP tool call, so it gets
  // Mastra's `mcp` category (default policy `ask`, see below).
  agent_start: "mcp",
  agent_prompt: "mcp",
  agent_output: "mcp",
  session_list: "mcp",
  // AgentController's built-in `subagent` spawner (WP-5) — spawning an
  // in-process reviewer is the same "reach outside this run" shape as the
  // daemon spawn verbs above, so it shares their `mcp` category and default
  // `ask` policy rather than `other`'s (also `ask` today, but a distinct
  // category keeps the two spawn surfaces — daemon vs. in-process — tunable
  // independently later without a behavior change now).
  subagent: "mcp",
  // Signal-provider subscription tools (WP-6) — deliberately NOT `mcp` like
  // the daemon verbs above: watching a session only registers an in-process
  // subscription whose polling reads session metadata and transcript events,
  // the same risk class as reading files. It can't spawn, prompt, or mutate
  // anything outside this process, so it auto-allows as `read` instead of
  // prompting on every watch.
  watch_session: "read",
  unwatch_session: "read",
  // `submit_plan` (WP-3) gates itself: calling it always suspends the run
  // for the user's approve/reject decision (see modes.ts's plan mode). It
  // has no "other"-category behavior worth asking about a second time before
  // that suspend even runs — see the per-tool "allow" override below.
  submit_plan: "other",
}

/** Resolve a tool id to its Mastra {@link ToolCategory}, or `null` if unmapped
 *  (the controller then treats it as category `'other'`). Matches the
 *  `AgentControllerConfig.toolCategoryResolver` signature. */
export function toolCategoryResolver(toolName: string): ToolCategory | null {
  return CATEGORY_BY_TOOL[toolName] ?? null
}

/**
 * Default approval policy: reads are auto-allowed, everything else asks —
 * except `submit_plan`, which is let through the generic tool-approval gate
 * so its own suspend-based plan-approval flow (see modes.ts) is the only
 * approval prompt the user sees for it, not a redundant "run submit_plan?"
 * ask in front of it.
 */
export const DEFAULT_PERMISSION_RULES: PermissionRules = {
  categories: {
    read: "allow",
    edit: "ask",
    execute: "ask",
    mcp: "ask",
    other: "ask",
  },
  tools: {
    submit_plan: "allow",
  },
}
