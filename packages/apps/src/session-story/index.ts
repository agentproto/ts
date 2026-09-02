/**
 * McpApp definition for the agentproto "session story" panel.
 *
 * A per-session readable timeline: a one-sentence mission + a plan strip of
 * inferred sub-task "chapters", a feed of steps segmented by chapter, and an
 * anchored side panel with plain-language + technical detail. Ported 1:1
 * from the validated mockup at docs/session-story-mockup.html.
 *
 * Uses the AgnoMcpApp contract (a local McpApp-compatible shape that does
 * NOT depend on @agstudio/mcp-apps). The host (@agentproto/runtime) wires
 * this factory's output via `registerMcpApps` at boot time — see runtime's
 * builtin-apps.ts.
 *
 * Protocol flow:
 *   1. Tool `agentproto_session_story` is called by the host, optionally
 *      with a `sessionId`.
 *   2. execute() returns just enough for the panel to boot: when a
 *      `sessionId` is given, it echoes that back and skips the sessions
 *      list entirely — the panel's own JS never reads the initial snapshot,
 *      it always re-fetches via `session_list` over the postMessage bridge
 *      on boot (see panel.ts's `loadSessions()`/boot sequence), so shipping
 *      the full list here would just be dead payload. When no `sessionId`
 *      is given (the picker case) it still returns the full sessions
 *      snapshot, since the model/host may surface it before the panel's
 *      own bridge call lands.
 *   3. The HTML panel opens a JSON-RPC bridge (postMessage) and drives
 *      everything else live: `session_list` for status polling,
 *      `agent_export` for the transcript (folded into chapters/steps with a
 *      JS port of @agentproto/runtime's session-story.ts heuristics — the
 *      panel HTML is fully self-contained, so it cannot import that TS
 *      module directly), and `agent_prompt` for the composer.
 */

import { z } from "zod"
import { SESSION_STORY_PANEL_HTML } from "./panel.js"
import type { AgnoMcpApp } from "../mcp-app-types.js"

// Re-exported so packages/vscode's storyPanel.ts (which reuses this HTML
// byte-for-byte in a VS Code webview) can import it from this app's
// subpath instead of reaching into ./panel.js directly.
export { SESSION_STORY_PANEL_HTML }

export const sessionStoryInputSchema = z.object({
  sessionId: z
    .string()
    .optional()
    .describe(
      "Session id to open directly. When omitted, the panel shows a session " +
        "picker (built from session_list) and lets the user choose.",
    ),
})

export type SessionStoryInput = z.infer<typeof sessionStoryInputSchema>
export type SessionStoryOutput<TSession = unknown> =
  | { sessions: TSession[]; sessionId?: string }
  | { sessionId: string }

/** Generic over the host's own session-descriptor shape — see
 *  sessions-panel/index.ts's SessionsPanelOps for why. */
export interface SessionStoryOps<TSession = unknown> {
  listSessions(filter?: "running" | "all"): TSession[]
}

export type { AgnoMcpApp }

/**
 * Factory: close over the sessions registry so execute() doesn't need
 * an AppContext (agentproto has no userId/guildId concept).
 */
export function makeSessionStoryPanelApp<TSession = unknown>(
  ops: SessionStoryOps<TSession>,
): AgnoMcpApp<SessionStoryInput, SessionStoryOutput<TSession>> {
  return {
    id: "agentproto_session_story",
    title: "Session Story",
    description:
      "Open the session story panel — a readable, per-session timeline for " +
      "two audiences at once: a plain-language summary of every step for " +
      "beginners, expandable to raw tool-call detail for technical users. " +
      "Shows a one-sentence mission, a plan strip of inferred sub-task " +
      "chapters, a chapter-segmented feed, and a composer to keep driving " +
      "the session. Polls live data and lets you jump to any step.",
    inputSchema: sessionStoryInputSchema,
    execute: async input =>
      input.sessionId
        ? { sessionId: input.sessionId }
        : { sessions: ops.listSessions("all") },
    html: SESSION_STORY_PANEL_HTML,
  }
}
