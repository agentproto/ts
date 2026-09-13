/**
 * App-only pull tools (WP-A) — data tools the live-session widget calls
 * over the MCP-App postMessage bridge. Registered with
 * `_meta.ui.visibility: ["app"]` (never `"model"`) so they never show up
 * in a regular agent's tool list; they exist purely for the widget's own
 * fetch loop. No resource is registered here — see `mcp-apps-adapter.ts`
 * for the tool that actually mounts the widget's HTML.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import { readFileSync } from "node:fs"
import type { SessionsRegistry } from "./sessions.js"
import { buildSessionTree } from "./session-tools.js"
import { sessionEventsPath } from "./transcript-writer.js"

export interface RegisterAppPullToolsOptions {
  registry: SessionsRegistry
}

/**
 * Pure reader over one session's events.jsonl — mirrors the exact
 * read/parse/skip-malformed/cap semantics of `GET /sessions/:id/events`
 * (http-server.ts) so the two surfaces never diverge. Extracted so it's
 * unit-testable without a live registry or MCP server.
 */
export function readSessionEventsSince(
  filePath: string,
  since: number,
  limit: number,
): { events: Record<string, unknown>[]; nextSeq: number; noTranscript: boolean } {
  let raw: string
  try {
    raw = readFileSync(filePath, "utf8")
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === "ENOENT") {
      return { events: [], nextSeq: since, noTranscript: true }
    }
    throw err
  }

  const events: Record<string, unknown>[] = []
  for (const line of raw.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let rec: Record<string, unknown>
    try {
      rec = JSON.parse(trimmed) as Record<string, unknown>
    } catch {
      continue
    }
    if (typeof rec.seq !== "number" || rec.seq <= since) continue
    if (events.length >= limit) continue
    events.push(rec)
  }

  const nextSeq =
    events.length > 0 ? (events[events.length - 1]?.seq as number) : since
  return { events, nextSeq, noTranscript: false }
}

export function registerAppPullTools(
  server: McpServer,
  opts: RegisterAppPullToolsOptions,
): void {
  const { registry } = opts

  server.registerTool(
    "app_session_tree",
    {
      description:
        "APP-ONLY: return the session hierarchy as a nested tree, for the " +
        "live-session widget's left pane. Not for agent use — see " +
        "`session_tree`.",
      inputSchema: {
        onlyAlive: z
          .boolean()
          .optional()
          .describe("When true, only include sessions with status running/starting."),
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
      },
      _meta: {
        ui: {
          visibility: ["app"],
        },
      },
    },
    async input => {
      let rows = registry.list({ includeArchived: true }).filter(s => !s.archived)
      if (input.onlyAlive) {
        rows = rows.filter(s => s.status === "running" || s.status === "starting")
      }
      const tree = buildSessionTree(rows)
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ tree }) }],
      }
    },
  )

  server.registerTool(
    "app_session_events",
    {
      description:
        "APP-ONLY: read one session's structured events.jsonl since a " +
        "cursor, for the live-session widget's right pane. Not for agent " +
        "use — see `GET /sessions/:id/events`.",
      inputSchema: {
        sessionId: z.string().describe("Session id or name — resolved the same way session_list does."),
        since: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("Only return events with seq greater than this cursor. Default 0."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(2000)
          .optional()
          .describe("Max events to return. Default 500."),
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
      },
      _meta: {
        ui: {
          visibility: ["app"],
        },
      },
    },
    async input => {
      const id = registry.findByIdOrName(input.sessionId)?.id ?? input.sessionId
      const since = input.since ?? 0
      const limit = input.limit ?? 500
      const filePath = sessionEventsPath(id)
      const result = readSessionEventsSince(filePath, since, limit)
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ events: result.events, nextSeq: result.nextSeq, ...(result.noTranscript ? { noTranscript: true } : {}) }),
          },
        ],
      }
    },
  )
}
