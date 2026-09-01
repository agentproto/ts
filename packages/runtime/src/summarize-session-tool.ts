/**
 * Server-side `summarize_session` tool — called by the agents-overview
 * panel (now @agentproto/apps/agents-overview) over its bridge for each
 * visible session to fetch a one-sentence summary + coarse state.
 *
 * Split out of the old agents-overview-app.ts when the panel's UI moved to
 * @agentproto/apps as a house app: this tool stays in runtime because it's
 * tied to the session ring-buffer/hot path (SessionDescriptor, tailLines)
 * that @agentproto/apps has no access to (apps has no dependency on
 * runtime — only runtime depends on apps, never the reverse).
 *
 * Today HEURISTIC — last meaningful output line + a state derived from
 * lifecycle/awaitingInput/recency. There is no LLM client wired into
 * @agentproto/runtime (egress/providers.ts is a proxy allowlist, not an
 * inference client; driver-agent-cli's `ModelLike.complete` would spawn a
 * fresh agent session per call — too heavy, and it would pollute the very
 * session list we render). When a real summarizer is wanted, swap the body
 * of `summarizeSession` for a `ModelLike.complete({system, prompt})` call;
 * the tool contract (1 sentence + state) stays the same.
 */

import { z } from "zod"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { SessionDescriptor } from "./sessions.js"
import { summarizeLines, deriveSessionState } from "./session-activity.js"
import type { SessionState } from "./session-activity.js"

export interface SessionSummary {
  sessionId: string
  summary: string
  state: SessionState
  status: SessionDescriptor["status"]
  label?: string
  lastOutputAt?: string
}

/** Build the full per-session summary from a descriptor + recent lines. */
export function summarizeSession(
  desc: SessionDescriptor,
  lines: readonly string[],
  nowMs: number,
): SessionSummary {
  return {
    sessionId: desc.id,
    summary: summarizeLines(lines, desc),
    state: deriveSessionState(desc, nowMs),
    status: desc.status,
    ...(desc.label ? { label: desc.label } : {}),
    ...(desc.lastOutputAt ? { lastOutputAt: desc.lastOutputAt } : {}),
  }
}

export interface SummarizeOps {
  getSession(id: string): SessionDescriptor | undefined
  /** Tail the recent ring buffer for a session (same source as
   *  agent_output). Returns [] for unknown sessions. */
  tailLines(id: string, lastN: number): string[]
  /** Current epoch-ms, injectable for tests. Defaults to Date.now. */
  now?: () => number
}

/**
 * Register the server-side `summarize_session` tool. The agents-overview
 * panel calls this via the bridge (callTool) for each visible session.
 */
export function registerSummarizeSessionTool(server: McpServer, ops: SummarizeOps): void {
  server.tool(
    "summarize_session",
    "Summarise a session in one plain sentence plus a coarse state " +
      "(à traiter / au travail / en attente / terminé). Heuristic today " +
      "(last meaningful output line + lifecycle/recency) — no LLM. Used by " +
      "the agents overview panel.",
    {
      sessionId: z.string().describe("Session id to summarise."),
      lastN: z
        .number()
        .int()
        .min(1)
        .max(500)
        .optional()
        .describe("Max recent lines to scan. Default 120."),
    },
    async input => {
      const desc = ops.getSession(input.sessionId)
      if (!desc) {
        return {
          content: [
            { type: "text" as const, text: `summarize_session: no session "${input.sessionId}"` },
          ],
          isError: true,
        }
      }
      const lines = ops.tailLines(input.sessionId, input.lastN ?? 120)
      const nowMs = (ops.now ?? Date.now)()
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(summarizeSession(desc, lines, nowMs), null, 2) },
        ],
      }
    },
  )
}
