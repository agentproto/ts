/**
 * McpApp definition for the agentproto "session story" panel.
 *
 * A per-session readable timeline: a one-sentence mission + a plan strip of
 * inferred sub-task "chapters", a feed of steps segmented by chapter, and an
 * anchored side panel with plain-language + technical detail. Ported 1:1
 * from the validated mockup at docs/session-story-mockup.html.
 *
 * Uses the same AgnoMcpApp contract as sessions-panel-app.ts (a local
 * McpApp-compatible shape that does NOT depend on @agstudio/mcp-apps —
 * agentproto is a separate pnpm workspace). Wire via `registerMcpApps`.
 *
 * Protocol flow:
 *   1. Tool `agentproto_session_story` is called by the host, optionally
 *      with a `sessionId`.
 *   2. execute() returns a small sessions snapshot (same shape as the other
 *      panels) plus the requested `sessionId` so the panel can auto-open it.
 *      When no `sessionId` is given the panel shows a session picker.
 *   3. The HTML panel opens a JSON-RPC bridge (postMessage) and drives
 *      everything else live: `session_list` for status polling,
 *      `agent_export` for the transcript (folded into chapters/steps with a
 *      JS port of session-story.ts's heuristics — the panel HTML is fully
 *      self-contained, so it cannot import the TS module directly), and
 *      `agent_prompt` for the composer.
 */

import { z } from "zod"
import { SESSION_STORY_PANEL_HTML } from "./session-story-panel.js"
import type { SessionDescriptor } from "./sessions.js"
import type { AgnoMcpApp } from "./sessions-panel-app.js"

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
export type SessionStoryOutput = { sessions: SessionDescriptor[]; sessionId?: string }

export interface SessionStoryOps {
  listSessions(filter?: "running" | "all"): SessionDescriptor[]
}

/**
 * Factory: close over the sessions registry so execute() doesn't need
 * an AppContext (agentproto has no userId/guildId concept).
 */
export function makeSessionStoryPanelApp(
  ops: SessionStoryOps,
): AgnoMcpApp<SessionStoryInput, SessionStoryOutput> {
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
    execute: async input => ({
      sessions: ops.listSessions("all"),
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    }),
    html: SESSION_STORY_PANEL_HTML,
  }
}
