/**
 * Routing rule for how a session opens — pure, no vscode import, so
 * `agentproto.openSession` and `agentproto.openSessionInChat` (extension.ts)
 * share one decision.
 *
 * `agentproto.sessionView` picks between the Session Chat app UI
 * (`@agentik/session-chat`, served by the daemon's standalone app host and
 * opened in a browser tab — the chat UI talks REST/SSE directly to the daemon,
 * not through the mcp-apps bridge) and the builtin transcript webview panel.
 * Chat wins only when the app is actually installed with a `ui` block;
 * otherwise we fall back silently to the builtin panel.
 */

import { appStandaloneUrl } from "../webview/appPanel.logic.js"
import type { InstalledAppInfo } from "../client/types.js"

export const SESSION_CHAT_APP_ID = "@agentik/session-chat"

export type SessionViewSetting = "chat" | "builtin"

export type SessionOpenRoute = { kind: "chat"; url: string } | { kind: "builtin" }

/** Deep-link into the session-chat UI with the picker pre-resolved. */
export function chatUrl(daemonUrl: string, sessionId: string): string {
  return `${appStandaloneUrl(daemonUrl, SESSION_CHAT_APP_ID)}?session=${encodeURIComponent(sessionId)}`
}

/** Whether an installed app record is the Session Chat app with a UI. */
export function installedSessionChatApp(apps: InstalledAppInfo[]): boolean {
  return apps.some(app => app.appId === SESSION_CHAT_APP_ID && !!app.ui)
}

/**
 * Resolve how a session opens:
 * - `chat` when the setting is `chat` AND the app is installed with a `ui`
 *   block — url is the standalone app host deep-linked to the session.
 * - otherwise `builtin` (setting is `builtin`, or the app is missing —
 *   silent fallback, no nagging).
 */
export function resolveSessionOpen(
  apps: InstalledAppInfo[],
  sessionView: SessionViewSetting,
  daemonUrl: string,
  sessionId: string,
): SessionOpenRoute {
  if (sessionView === "chat" && installedSessionChatApp(apps)) {
    return { kind: "chat", url: chatUrl(daemonUrl, sessionId) }
  }
  return { kind: "builtin" }
}