/**
 * `ops-panel` — the agentproto daemon operations cockpit as an app.
 *
 * Two durable "special sessions" ship as agents — the Session Watchdog
 * (cron-ticked health checks: classify, flag, archive; never kills) and the
 * Sessions Manager (the coordinator the human talks to, which drives the
 * other sessions). The panel (`ui.ts`) launches/restarts them by label,
 * wires the watchdog's `watchdog-tick` cron, lists every session filterable
 * by workspace with lifecycle actions, and fronts housekeeping: session GC,
 * worktree GC (dry-run first), and the cron ledger.
 */

import { defineApp, type AppHandle } from "@agentproto/app-kit"
import { manager } from "./agents/manager.js"
import { watchdog } from "./agents/watchdog.js"
import { OPS_PANEL_HTML, OPS_PANEL_TOOLS } from "./ui.js"

export const opsPanel: AppHandle = defineApp({
  id: "@agentproto/ops-panel",
  name: "Ops Panel",
  version: "0.1.0",
  description: "Daemon ops cockpit — watchdog & manager sessions, workspace-filtered session list, GC and cron housekeeping.",
  agents: [watchdog, manager],
  ui: {
    html: OPS_PANEL_HTML,
    title: "Ops Panel",
    tools: [...OPS_PANEL_TOOLS],
  },
})

export { watchdog, manager }
export { WATCHDOG_LABEL, WATCHDOG_TICK_LABEL, WATCHDOG_TICK_PROMPT, WATCHDOG_TICK_SCHEDULE } from "./agents/watchdog.js"
export { MANAGER_LABEL } from "./agents/manager.js"
