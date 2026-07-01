/**
 * McpApp definition for the agentproto sessions panel.
 *
 * Uses the AgnoMcpApp contract (a local McpApp-compatible shape that does
 * NOT depend on @agstudio/mcp-apps or Mastra — agentproto is a separate
 * pnpm workspace). Wire via `registerMcpApps` from mcp-apps-adapter.ts.
 *
 * Protocol flow:
 *   1. Tool `agentproto_sessions` is called by the host.
 *   2. execute() returns a sessions snapshot → injected into the HTML as
 *      window.__APP_INIT__ (static initial render, no bridge needed).
 *   3. The HTML panel opens a JSON-RPC bridge (postMessage) and polls
 *      `session_list` + `agent_output` every 3 s for live data.
 */

import { z } from "zod"
import { PANEL_HTML } from "./sessions-panel.js"
import type { SessionDescriptor } from "./sessions.js"

export const sessionsPanelInputSchema = z.object({
  filter: z
    .enum(["running", "all"])
    .optional()
    .describe(
      "Which sessions to return. `running` = only alive; `all` = running + recent (default).",
    ),
})

export type SessionsInput = z.infer<typeof sessionsPanelInputSchema>
export type SessionsOutput = { sessions: SessionDescriptor[] }

export interface SessionsPanelOps {
  listSessions(filter?: "running" | "all"): SessionDescriptor[]
}

/**
 * Local McpApp-compatible shape — mirrors @agstudio/mcp-apps McpApp<TIn,TOut>
 * without importing it (cross-workspace isolation).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface AgnoMcpApp<TInput = unknown, TOutput = unknown> {
  id: string
  title: string
  description?: string
  /** Must be a z.object({...}) so registerMcpApps can extract .shape. */
  inputSchema: z.ZodObject<z.ZodRawShape>
  execute?: (input: TInput) => Promise<TOutput>
  html: string | ((initData: TOutput) => string)
}

/**
 * Factory: close over the sessions registry so execute() doesn't need
 * an AppContext (agentproto has no userId/guildId concept).
 */
export function makeSessionsPanelApp(
  ops: SessionsPanelOps,
): AgnoMcpApp<SessionsInput, SessionsOutput> {
  return {
    id: "agentproto_sessions",
    title: "Agent Sessions",
    description:
      "Open the agentproto sessions panel — an interactive UI that shows all " +
      "running and recent sessions (agent-CLI, terminal/PTY, commands). " +
      "The panel polls live data and lets you inspect output or kill sessions.",
    inputSchema: sessionsPanelInputSchema,
    execute: async (input) => ({
      sessions: ops.listSessions(input.filter),
    }),
    html: PANEL_HTML,
  }
}
