/**
 * McpApp definition for the agentproto "agents — vue claire" panel.
 *
 * A plain-language overview of agent-cli sessions: one card per session
 * with a single human sentence (what the agent is doing/last said) plus a
 * coarse state — `à traiter` / `au travail` / `en attente` / `terminé`.
 *
 * Uses the AgnoMcpApp contract (a local McpApp-compatible shape that does
 * NOT depend on @agstudio/mcp-apps). The host (@agentproto/runtime) wires
 * this factory's output via `registerMcpApps` at boot time — see runtime's
 * builtin-apps.ts.
 *
 * Protocol flow:
 *   1. Tool `agentproto_agents_overview` is called by the host.
 *   2. execute() returns the agent-session snapshot → injected into the
 *      HTML as the initial render via the tool result JSON.
 *   3. The HTML panel opens a JSON-RPC bridge (postMessage) and polls
 *      `session_list` every ~12 s, then calls `summarize_session` for
 *      each visible session to fetch the plain sentence + state.
 *
 * The per-session summary is generated SERVER-SIDE by the
 * `summarize_session` tool, which stays in @agentproto/runtime
 * (summarize-session-tool.ts) — it's tied to the runtime's session
 * ring-buffer/hot path, not to this panel's UI. Only the panel factory +
 * HTML live here.
 *
 * This module also exports `agentsOverviewApp`, a real `defineApp()`
 * `AppHandle` (`agents: []`, UI-only) — the catalog/emit/`app_install` path.
 * It's separate from `makeAgentsOverviewApp` above, which the daemon mounts
 * directly at boot: that factory closes over LIVE `listSessions`, something
 * a static emitted `ui.html` snapshot can't carry.
 */

import { z } from "zod"
import { defineApp, type AppHandle } from "@agentproto/app-kit"
import { AGENTS_OVERVIEW_HTML } from "./panel.js"
import type { AgnoMcpApp } from "../mcp-app-types.js"

export const agentsOverviewInputSchema = z.object({
  filter: z
    .enum(["running", "all"])
    .optional()
    .describe("`running` = only alive agent sessions; `all` = running + recent (default)."),
})

export type AgentsOverviewInput = z.infer<typeof agentsOverviewInputSchema>
export type AgentsOverviewOutput<TSession = unknown> = { sessions: TSession[] }

/** Generic over the host's own session-descriptor shape — see
 *  sessions-panel/index.ts's SessionsPanelOps for why. */
export interface AgentsOverviewOps<TSession = unknown> {
  listSessions(filter?: "running" | "all"): TSession[]
}

export type { AgnoMcpApp }

export function makeAgentsOverviewApp<TSession = unknown>(
  ops: AgentsOverviewOps<TSession>,
): AgnoMcpApp<AgentsOverviewInput, AgentsOverviewOutput<TSession>> {
  return {
    id: "agentproto_agents_overview",
    title: "Agents — vue claire",
    description:
      "Open the agents overview — a plain-language card per agent session " +
      "with one human sentence (what it's doing / last said) and a coarse " +
      "state (à traiter / au travail / en attente / terminé). Polls live and " +
      "asks the server to summarise each session.",
    inputSchema: agentsOverviewInputSchema,
    execute: async input => ({ sessions: ops.listSessions(input.filter) }),
    html: AGENTS_OVERVIEW_HTML,
  }
}

export const agentsOverviewApp: AppHandle = defineApp({
  id: "@agentproto/agents-overview",
  name: "Agents — vue claire",
  description:
    "Open the agents overview — a plain-language card per agent session with one human sentence " +
    "and a coarse state (à traiter / au travail / en attente / terminé).",
  agents: [],
  ui: {
    html: AGENTS_OVERVIEW_HTML,
    title: "Agents — vue claire",
    tools: ["session_list", "summarize_session"],
  },
})
