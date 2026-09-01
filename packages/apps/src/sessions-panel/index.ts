/**
 * McpApp definition for the agentproto sessions panel.
 *
 * Uses the AgnoMcpApp contract (a local McpApp-compatible shape that does
 * NOT depend on @agstudio/mcp-apps or Mastra). The host (@agentproto/runtime)
 * wires this factory's output via `registerMcpApps` from its
 * mcp-apps-adapter.ts at boot time — see runtime's builtin-apps.ts.
 *
 * Protocol flow:
 *   1. Tool `agentproto_sessions` is called by the host.
 *   2. execute() returns a sessions snapshot → injected into the HTML as
 *      window.__APP_INIT__ (static initial render, no bridge needed).
 *   3. The HTML panel opens a JSON-RPC bridge (postMessage) and polls
 *      `session_list` + `agent_output` every 3 s for live data.
 */

import { z } from "zod"
import { PANEL_HTML } from "./panel.js"
import type { AgnoMcpApp } from "../mcp-app-types.js"

export const sessionsPanelInputSchema = z.object({
  filter: z
    .enum(["running", "all"])
    .optional()
    .describe(
      "Which sessions to return. `running` = only alive; `all` = running + recent (default).",
    ),
})

export type SessionsInput = z.infer<typeof sessionsPanelInputSchema>
export type SessionsOutput<TSession = unknown> = { sessions: TSession[] }

/**
 * Generic over the host's own session-descriptor shape — this package
 * doesn't own that type (it lives in @agentproto/runtime's session
 * registry), so the factory stays agnostic to it and the host supplies the
 * concrete type as a type argument when it wires the app up.
 */
export interface SessionsPanelOps<TSession = unknown> {
  listSessions(filter?: "running" | "all"): TSession[]
}

export type { AgnoMcpApp }

/**
 * Factory: close over the sessions registry so execute() doesn't need
 * an AppContext (agentproto has no userId/guildId concept).
 */
export function makeSessionsPanelApp<TSession = unknown>(
  ops: SessionsPanelOps<TSession>,
): AgnoMcpApp<SessionsInput, SessionsOutput<TSession>> {
  return {
    id: "agentproto_sessions",
    title: "Agent Sessions",
    description:
      "Open the agentproto sessions panel — an interactive UI that shows all " +
      "running and recent agent-CLI and terminal/PTY sessions. Raw shell-" +
      "command runs are a log, not a resumable session, and don't appear " +
      "here — see `command_list`. The panel polls live data and lets you " +
      "inspect output or kill sessions.",
    inputSchema: sessionsPanelInputSchema,
    execute: async (input) => ({
      sessions: ops.listSessions(input.filter),
    }),
    html: PANEL_HTML,
  }
}
