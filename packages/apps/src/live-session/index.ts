/**
 * McpApp definition for the live-session widget — a two-pane panel (left:
 * live session tree, right: streaming timeline) that lets a host attach to
 * any running agent session and watch it work in real time.
 *
 * The HTML bundle itself (`LIVE_SESSION_HTML`, its wire protocol, the
 * inlined timeline-reducer copy, compact-mode rendering, …) lives in
 * ./panel.ts, which imports nothing beyond plain TS — see that file for the
 * full protocol/rendering doc. Kept separate so a consumer that only needs
 * the HTML can import `@agentproto/apps/live-session/panel` without pulling
 * in `@agentproto/app-kit` (and therefore `@mastra/core`) the way importing
 * from this file would.
 *
 * This module also exports `liveSessionApp`, a real `defineApp()`
 * `AppHandle` (`agents: []`, UI-only) — the catalog/emit/`app_install` path.
 * Its `ui.html` is a static snapshot (`LIVE_SESSION_HTML` called with the
 * default `httpBaseUrl`) since `AppUiDefinition.ui.html` must be a plain
 * string; it's separate from `makeLiveSessionApp` above, which the daemon
 * mounts directly at boot with the real daemon origin baked in per-call.
 */

import { z } from "zod"
import { defineApp, type AppHandle } from "@agentproto/app-kit"
import type { AgnoMcpApp } from "../mcp-app-types.js"
import { LIVE_SESSION_HTML, type LiveSessionOutput } from "./panel.js"

export { LIVE_SESSION_HTML }
export type { LiveSessionOutput }

export const liveSessionInputSchema = z.object({
  sessionId: z
    .string()
    .optional()
    .describe(
      "Attach the widget to an existing session by id or name. Omit to " +
        "self-discover the newest running session from the tree.",
    ),
})

export type LiveSessionInput = z.infer<typeof liveSessionInputSchema>

export interface LiveSessionOps {
  /** The daemon's own HTTP origin, e.g. "http://127.0.0.1:18790". Defaults
   *  to the daemon's documented default port (`index.ts:776`) so the app
   *  works out of the box in the common single-daemon case. */
  httpBaseUrl?: string
}

/**
 * Factory: close over the daemon's own HTTP origin so execute() needs
 * nothing beyond the tool input (no registry access — mirrors
 * sessions-panel/index.ts and runtime's terminal-panel-app.ts; the app_*
 * tools this widget calls over the bridge are what actually touch the
 * registry).
 */
export function makeLiveSessionApp(
  ops?: LiveSessionOps,
): AgnoMcpApp<LiveSessionInput, LiveSessionOutput> {
  const httpBaseUrl = ops?.httpBaseUrl ?? "http://127.0.0.1:18790"
  // `new URL(...).origin` normalises the base URL to the exact connectDomains
  // entry the CSP allowlist needs (same derivation as terminal-panel-app.ts's
  // wsOrigin), covering both the SSE EventSource and any bridge fallback.
  const httpOrigin = new URL(httpBaseUrl).origin

  return {
    id: "live_session",
    title: "Live Session",
    description:
      "Open the live session widget — a two-pane view of a running agent " +
      "session: a live tree on the left, a streaming timeline (text, tool " +
      "calls/results, turn-end) on the right. Omit `sessionId` to " +
      "attach to the newest running session; pass one to attach directly.",
    inputSchema: liveSessionInputSchema,
    execute: async input => ({
      sessionId: input.sessionId,
      httpBaseUrl,
    }),
    html: (initData: LiveSessionOutput) => LIVE_SESSION_HTML(initData),
    csp: { connectDomains: [httpOrigin] },
  }
}

const DEFAULT_HTTP_BASE_URL = "http://127.0.0.1:18790"

export const liveSessionApp: AppHandle = defineApp({
  id: "@agentproto/live-session",
  name: "Live Session",
  description:
    "Open the live session widget — a two-pane view of a running agent session: a live tree on " +
    "the left, a streaming timeline (text, tool calls/results, turn-end) on the right.",
  agents: [],
  ui: {
    html: LIVE_SESSION_HTML({ httpBaseUrl: DEFAULT_HTTP_BASE_URL }),
    title: "Live Session",
    tools: ["app_session_tree", "app_session_events", "live_session"],
  },
})
