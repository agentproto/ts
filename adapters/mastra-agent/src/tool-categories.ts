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
}

/** Resolve a tool id to its Mastra {@link ToolCategory}, or `null` if unmapped
 *  (the controller then treats it as category `'other'`). Matches the
 *  `AgentControllerConfig.toolCategoryResolver` signature. */
export function toolCategoryResolver(toolName: string): ToolCategory | null {
  return CATEGORY_BY_TOOL[toolName] ?? null
}

/** Default approval policy: reads are auto-allowed, everything else asks. */
export const DEFAULT_PERMISSION_RULES: PermissionRules = {
  categories: {
    read: "allow",
    edit: "ask",
    execute: "ask",
    mcp: "ask",
    other: "ask",
  },
  tools: {},
}
