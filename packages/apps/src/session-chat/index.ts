/**
 * McpApp definition for the session-chat builtin widget — a thin launcher
 * for the installed `@agentik/session-chat` app's UI, exposed as a BUILTIN
 * daemon panel so MCP-Apps clients (and the VS Code appPanel surface) can
 * open the chat from `app_catalog` without installing anything into the
 * MCP surface itself.
 *
 * Uses the AgnoMcpApp contract (a local McpApp-compatible shape that does
 * NOT depend on @agstudio/mcp-apps or Mastra), same as sessions-panel /
 * live-session — the host (@agentproto/runtime) wires this factory's output
 * via `registerMcpApps` from its mcp-apps-adapter.ts at boot time, with the
 * mounted list assembled in runtime's builtin-apps.ts.
 *
 * Serving approach (decided; see the PR description for the tradeoffs):
 *   (a) App installed → the tool returns the app's standalone deep-link
 *       (`GET /apps/@agentik/session-chat/ui?session=<id>&embed=1`) and the
 *       panel HTML is a thin full-viewport iframe of it. No duplicate chat
 *       bundle: the UI is the studio-built app, served by the daemon's
 *       standalone app host. The daemon relaxes that route's
 *       `frame-ancestors 'none'` only when `?embed=1` is present.
 *   (b) App NOT installed → the panel HTML is a small readable notice
 *       pointing at `agentproto app install`. Never a vendored/reimplemented
 *       chat UI.
 *
 * This module also exports `sessionChatApp`, a real `defineApp()`
 * `AppHandle` (`agents: []`, UI-only) — the catalog/emit/`app_install`
 * path. Its `ui.html` is the fallback notice, since `AppUiDefinition.ui.html`
 * is a plain static string and can't know at emit time whether the sibling
 * app is installed; the live-mounted `makeSessionChatApp` below is the one
 * that resolves installed-ness per boot.
 */

import { z } from "zod"
import { defineApp, type AppHandle } from "@agentproto/app-kit"
import type { AgnoMcpApp } from "../mcp-app-types.js"
import { SESSION_CHAT_FALLBACK_HTML, sessionChatEmbedHtml } from "./panel.js"

export { SESSION_CHAT_FALLBACK_HTML, sessionChatEmbedHtml }

/** The installed studio app this builtin widget is a launcher for. */
export const SESSION_CHAT_APP_ID = "@agentik/session-chat"

export const sessionChatInputSchema = z.object({
  sessionId: z
    .string()
    .optional()
    .describe(
      "Deep-link the chat to an existing session by id (e.g. `sess_xxx`). " +
        "Omit to open the app with its session picker.",
    ),
})

export type SessionChatInput = z.infer<typeof sessionChatInputSchema>

export interface SessionChatOutput {
  /** Whether the `@agentik/session-chat` app is installed (with a UI) on
   *  the daemon this widget is mounted on. */
  installed: boolean
  /** The app's standalone deep-link url when installed, else null. */
  url: string | null
}

export interface SessionChatOps {
  /** The daemon's own HTTP origin, e.g. "http://127.0.0.1:18790" — the
   *  standalone app host the chat UI is served from. */
  httpBaseUrl: string
  /** Whether the `@agentik/session-chat` app is installed with a `ui`
   *  block. The runtime supplies this from its AppRegistry; optional so
   *  tests/consumers without a registry can omit it (treated as false). */
  isSessionChatInstalled?: () => boolean
}

/**
 * Deep-link into the installed app's standalone UI — the same url shape the
 * VS Code chat-panel webview iframes (`chatPanelUrl` in
 * packages/vscode/src/commands/sessionView.logic.ts).
 */
export function sessionChatAppUrl(httpBaseUrl: string, sessionId?: string): string {
  const base = `${httpBaseUrl.replace(/\/+$/, "")}/apps/${SESSION_CHAT_APP_ID}/ui`
  const params = new URLSearchParams()
  if (sessionId) params.set("session", sessionId)
  params.set("embed", "1")
  return `${base}?${params.toString()}`
}

/** The daemon origin the widget's host-iframe CSP must allow as a frame
 *  target (same derivation as live-session's connectDomains entry). */
function frameOrigin(httpBaseUrl: string): string {
  return new URL(httpBaseUrl).origin
}

/**
 * Factory: close over the daemon origin + the installed-ness check so
 * execute() needs nothing beyond the tool input (no registry access inside
 * the app itself — mirrors live-session/index.ts).
 */
export function makeSessionChatApp(
  ops: SessionChatOps,
): AgnoMcpApp<SessionChatInput, SessionChatOutput> {
  const installed = ops.isSessionChatInstalled?.() ?? false
  return {
    id: "agentproto_session_chat",
    title: "Session Chat",
    description:
      "Open the Session Chat app — a chat-thread view of any agentproto " +
      "daemon session: full transcript replay, live follow-over SSE, and a " +
      "composer that sends prompts into the same session. Requires the " +
      "`@agentik/session-chat` app to be installed; without it the panel " +
      "shows install instructions. Pass `sessionId` to deep-link straight " +
      "into a known session.",
    inputSchema: sessionChatInputSchema,
    execute: async input => ({
      installed,
      url: installed ? sessionChatAppUrl(ops.httpBaseUrl, input.sessionId) : null,
    }),
    html: (initData: SessionChatOutput) => sessionChatEmbedHtml(initData),
    csp: { frameDomains: [frameOrigin(ops.httpBaseUrl)] },
  }
}

export const sessionChatApp: AppHandle = defineApp({
  id: "@agentproto/session-chat-widget",
  name: "Session Chat",
  description:
    "Open the Session Chat app — a chat-thread view of any agentproto daemon session, deep-linked " +
    "by sessionId. A thin builtin launcher for the installed @agentik/session-chat app.",
  agents: [],
  ui: {
    html: SESSION_CHAT_FALLBACK_HTML,
    title: "Session Chat",
    tools: ["session_list", "agent_start", "adapter_list", "conversation_read"],
  },
})
