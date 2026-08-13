/**
 * `session-viewer` — a single-agent agentproto app for reading daemon
 * sessions as a clean conversation.
 *
 * The panel (`ui.ts`) picks a session — live or finished — from
 * `session_list` and renders its transcript via `conversation_read`: user/
 * assistant turns, collapsible tool calls, timestamps, a metadata header.
 * Read-only, no spawn/kill/resume action. The bundled `session-narrator`
 * agent is a complementary plain-English narrator over the same
 * `conversation_read` data — usable standalone via `app_run`, independent
 * of the panel.
 */

import { defineApp, type AppHandle } from "@agentproto/app-kit"
import { narrator } from "./agents/narrator.js"
import { narrateSession } from "./workflows/narrate-session.js"
import { SESSION_VIEWER_HTML, SESSION_VIEWER_TOOLS } from "./ui.js"

export const sessionViewer: AppHandle = defineApp({
  id: "@agentproto/session-viewer",
  name: "Session Viewer",
  version: "0.1.0",
  description: "Read a daemon session as a clean conversation — turns, tool calls, timestamps.",
  agents: [narrator],
  workflows: [narrateSession],
  ui: {
    html: SESSION_VIEWER_HTML,
    title: "Session Viewer",
    tools: [...SESSION_VIEWER_TOOLS],
  },
})

export { narrator, narrateSession }
