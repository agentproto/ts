/**
 * HTML bundle for the agentproto review-panel — the `REVIEW_PANEL_HTML`
 * served as the `ui://agentproto_reviews/view` resource by `registerMcpApps`
 * (see ../mcp-app-types.ts and runtime's mcp-apps-adapter.ts). Mounted via
 * the `agentproto_reviews` tool defined in ./index.ts.
 *
 * A verdict panel over the daemon's review ledger
 * (`packages/runtime/src/review-ledger.ts` + `review-runner.ts`'s in-flight
 * runs) — list view (running first, then newest) and a per-run detail view
 * (lanes, findings, agent-lane provenance).
 *
 * `REVIEW_PANEL_HTML` is a real single-file Vite build, not a hand-authored
 * template string — same technique as work-board (see that package's
 * ./panel.ts docblock): the source lives in ./ui/** (index.html/main.ts/
 * types.ts/render.ts/style.css, bundled by ./ui/vite.config.ts with
 * vite-plugin-singlefile) and is committed, pre-built, into
 * ./panel.generated.ts by `pnpm --filter @agentproto/apps run build:ui:reviews`
 * (scripts/build-review-panel-ui.mjs) — so this package still builds with
 * plain `pnpm build` on a fresh clone, no Vite step in the critical path.
 * `build:ui:reviews:check` (wired into CI) fails if that generated file
 * drifts from what the Vite sources actually produce.
 *
 * Protocol: MCP Apps ext spec 2026-01-26
 *   – Bridge: JSON-RPC 2.0 over window.parent.postMessage (../panel-bridge.ts)
 *   – Handshake: ui/initialize → host result → ui/notifications/initialized
 *   – Data: tools/call → review_ledger (`includeRunning: true`) on a poll
 *     that speeds up to ~4s while any row is running, ~15s otherwise; a
 *     selected row's detail comes from review_status (runId)
 *   – Actions: tools/call → review_cancel / review_run (nocache + wait:false
 *     + supersede, "Re-run fresh") / review_pr / review_export — real tool
 *     names only, no second write path
 *   – Deep link: an agent lane's reviewer-session id calls tools/call →
 *     live_session (sessionId) — the SAME cross-app auto-render mechanism
 *     agent_start uses for the session-chat launcher (its tool definition
 *     carries `_meta.ui.resourceUri: "ui://live_session/view"`), so the
 *     host opens/focuses that widget already pinned to the exact reviewer
 *     session instead of the generic newest-running one.
 *
 * The verdict/status chip (never render a running/cancelled run as if it
 * had a verdict): pass/block/incomplete/running/cancelled/failed, one
 * visual language everywhere it appears — see ./ui/render.ts's `verdictChip`.
 */

import { REVIEW_PANEL_HTML_GENERATED } from "./panel.generated.js"

/** The builtin's app id — how `app_catalog` reports the panel. Lives in this
 *  html-only entry (not ./index.ts) so a consumer that must NOT pull the
 *  app-kit dependency graph can still name the panel from source (mirrors
 *  work-board/panel.ts's `WORK_BOARD_APP_ID`). */
export const REVIEW_PANEL_APP_ID = "@agentproto/review-panel"

/** The MCP tool the panel is registered under (./index.ts
 *  `makeReviewPanelApp`), hence its resource uri `ui://agentproto_reviews/view`. */
export const REVIEW_PANEL_TOOL_ID = "agentproto_reviews"

/** The daemon tools this panel's html calls, in order of first use. Consumed
 *  as `ui.tools` by ./index.ts and as the client-side allowlist by any host
 *  that dispatches the panel's `tools/call` directly. `live_session` isn't
 *  a review tool — it's how an agent lane's reviewer-session link
 *  deep-links the live-session widget (see ./ui/render.ts's
 *  `sessionLinkCall`); it has to be on this allowlist too, or the
 *  standalone REST bridge (`performBuiltinPanelToolCall`) refuses the call. */
export const REVIEW_PANEL_UI_TOOLS = [
  "review_ledger",
  "review_status",
  "review_cancel",
  "review_run",
  "review_pr",
  "review_export",
  "live_session",
] as const

export const REVIEW_PANEL_HTML = REVIEW_PANEL_HTML_GENERATED
