/**
 * `reach_send`: any session tells the owner something through the REACH
 * route (`tell.ts`). Model-visible. The caller is the session named by
 * `?callerSessionId=` on the `/mcp` connection; no session means the host.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"

import type { ReachTeller } from "./tell.js"

export interface RegisterReachToolsOptions {
  /** Absent: the tool registers but answers a structured error. */
  teller?: ReachTeller
  callerSessionId?: string
  /** The caller's operatorLabel, else its label. */
  callerLabel?: () => string | undefined
}

export function registerReachTools(server: McpServer, opts: RegisterReachToolsOptions): void {
  server.tool(
    "reach_send",
    "Tell the owner something through the daemon's REACH route (the owner's phone or chat). A tell only: " +
      "no question, no answer comes back. Use it sparingly, for what the owner would want to know now. " +
      "`dedupeKey` is required: the same key from your session within 24 h sends nothing and answers " +
      '"deduped". At most 20 tells per session per day. Answers { status, adapterId?, attempts }.',
    {
      summary: z.string().min(1).max(1000).describe("What the owner reads. Plain text, 1 to 1000 characters."),
      links: z
        .array(z.object({ url: z.url({ protocol: /^https$/ }), label: z.string().max(200).optional() }))
        .max(3)
        .optional()
        .describe("At most 3 https links."),
      dedupeKey: z.string().min(1).max(200).describe("Stable key for this news: a repeat sends nothing."),
      via: z.string().optional().describe("A route entry id to try first; the rest of the route follows."),
      urgency: z
        .enum(["normal", "digest"])
        .optional()
        .describe('Default "normal". "digest" may be grouped.'),
    },
    async input => {
      const label = opts.callerLabel?.()
      const result = opts.teller
        ? await opts.teller.send({
            summary: input.summary,
            ...(input.links ? { links: input.links } : {}),
            dedupeKey: input.dedupeKey,
            ...(input.via !== undefined ? { via: input.via } : {}),
            ...(input.urgency !== undefined ? { urgency: input.urgency } : {}),
            source: {
              ...(opts.callerSessionId ? { sessionId: opts.callerSessionId } : {}),
              ...(label ? { label } : {}),
            },
          })
        : { error: "reach_not_available" }
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }] }
    },
  )
}
