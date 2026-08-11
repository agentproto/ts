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
  // Daemon verbs, arriving in WP-5.
  agent_start: "mcp",
  agent_prompt: "mcp",
  agent_output: "mcp",
  session_list: "mcp",
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
