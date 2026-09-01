/**
 * McpApp definition for the agentproto "bureau — sessions navigateur" panel.
 *
 * Shows the browser sessions (kind === "browser"): adapter, base URL, port,
 * status and uptime. One row per live/recent browser service so you can see
 * what's bound where at a glance.
 *
 * Uses the AgnoMcpApp contract (a local McpApp-compatible shape that does
 * NOT depend on @agstudio/mcp-apps). The host (@agentproto/runtime) wires
 * this factory's output via `registerMcpApps` at boot time — see runtime's
 * builtin-apps.ts.
 *
 * Protocol flow:
 *   1. Tool `agentproto_bureau_sessions` is called by the host.
 *   2. execute() returns the browser-session snapshot.
 *   3. The HTML panel opens a JSON-RPC bridge (postMessage) and polls
 *      `session_list {kind:'all'}` every ~5 s, filtering to kind==="browser".
 *
 * Data only — no server LLM. The whole bundle is inline (zero CDN).
 */

import { z } from "zod"
import { BUREAU_SESSIONS_HTML } from "./panel.js"
import type { AgnoMcpApp } from "../mcp-app-types.js"

export const bureauSessionsInputSchema = z.object({
  filter: z
    .enum(["running", "all"])
    .optional()
    .describe("`running` = only alive browser sessions; `all` = running + recent (default)."),
})

export type BureauSessionsInput = z.infer<typeof bureauSessionsInputSchema>
export type BureauSessionsOutput<TSession = unknown> = { sessions: TSession[] }

/** Generic over the host's own session-descriptor shape — see
 *  sessions-panel/index.ts's SessionsPanelOps for why. */
export interface BureauSessionsOps<TSession extends { kind: string }> {
  listSessions(filter?: "running" | "all"): TSession[]
}

export type { AgnoMcpApp }

export function makeBureauSessionsApp<TSession extends { kind: string }>(
  ops: BureauSessionsOps<TSession>,
): AgnoMcpApp<BureauSessionsInput, BureauSessionsOutput<TSession>> {
  return {
    id: "agentproto_bureau_sessions",
    title: "Bureau — sessions navigateur",
    description:
      "Open the browser-sessions panel — one row per browser service " +
      "(adapter, base URL, port, status, uptime). Polls live every ~5 s.",
    inputSchema: bureauSessionsInputSchema,
    execute: async input => ({
      sessions: ops.listSessions(input.filter).filter(s => s.kind === "browser"),
    }),
    html: BUREAU_SESSIONS_HTML,
  }
}
