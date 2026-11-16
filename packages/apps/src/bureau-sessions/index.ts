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
 *
 * This module also exports `bureauSessionsApp`, a real `defineApp()`
 * `AppHandle` (`agents: []`, UI-only) — the catalog/emit/`app_install` path.
 * It's separate from `makeBureauSessionsApp` above, which the daemon mounts
 * directly at boot: that factory closes over LIVE `listSessions`, something
 * a static emitted `ui.html` snapshot can't carry.
 */

import { z } from "zod"
import { defineApp, type AppHandle } from "@agentproto/app"
import { BUREAU_SESSIONS_HTML } from "./panel.js"
import type { AgnoMcpApp } from "../mcp-app-types.js"

/**
 * What this panel really is. It lists the daemon's `kind: "browser"` sessions,
 * which only the retired chrome-live path created; the daemon browser tools now
 * relay to Bureau and create none, so the panel is normally empty
 * and never shows Bureau. The name is kept (the tool id is a public surface:
 * generated tool names, tool profiles, the package export).
 */
const LEGACY_DESCRIPTION =
  "LEGACY panel, not Bureau: lists the daemon's browser sessions from the retired chrome-live " +
  "path (adapter, base URL, port, status, uptime), normally empty today. It says nothing " +
  "about Bureau. For Bureau use bureau_overview / bureau_list_instances / bureau_list_owned_tabs, " +
  "or Bureau's own tools (see the `browser` skill)."

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
    description: LEGACY_DESCRIPTION + " Polls live every ~5 s.",
    inputSchema: bureauSessionsInputSchema,
    execute: async input => ({
      sessions: ops.listSessions(input.filter).filter(s => s.kind === "browser"),
    }),
    html: BUREAU_SESSIONS_HTML,
  }
}

export const bureauSessionsApp: AppHandle = defineApp({
  id: "@agentproto/bureau-sessions",
  name: "Bureau — sessions navigateur",
  description: LEGACY_DESCRIPTION,
  agents: [],
  ui: {
    html: BUREAU_SESSIONS_HTML,
    title: "Bureau — sessions navigateur",
    tools: ["session_list"],
  },
})
