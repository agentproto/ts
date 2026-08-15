/**
 * MCP tools that expose the per-workspace brain to agents.
 *
 * Three tools over the shared {@link WorkspaceBrains} registry:
 *
 *   - `workspace_brain_query`  — BM25 recall over a workspace's ingested
 *                                conversations (dispatch to the provider).
 *   - `workspace_brain_status` — how many sessions a workspace has ingested.
 *   - `workspace_brain_ingest` — manually trigger ingestion (a session, or
 *                                every known-but-uningested session).
 *
 * Every tool resolves its target workspace the same way: an explicit
 * `workspace` argument wins; otherwise the calling session's own workspace is
 * used (from its descriptor's `workspaceSlug`). Resolution applies the bucket
 * membership rule, so an unregistered slug degrades to `default` rather than
 * pointing a brain at an arbitrary path.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import type { SessionsRegistry } from "./sessions.js"
import type { WorkspaceBrains } from "./workspace-brains.js"

/** MCP clients commonly stringify booleans; coerce so both the boolean
 *  `true`/`false` and the string literals `"true"`/`"false"` are accepted. */
const mcpBool = z.preprocess(
  v => (v === "true" ? true : v === "false" ? false : v),
  z.boolean(),
)

export interface RegisterBrainToolsOptions {
  /** The shared per-workspace brain registry. */
  brains: WorkspaceBrains
  /** Registry used to resolve the calling session's own workspace. */
  registry: SessionsRegistry
  /** The calling agent session id (from `?callerSessionId=` on `/mcp`). */
  callerSessionId?: string
}

/** Resolve the target workspace: explicit arg wins, else the caller's slug.
 *  Falls back to `default` when neither resolves to a registered bucket. */
function resolveTargetWorkspace(
  brains: WorkspaceBrains,
  registry: SessionsRegistry,
  callerSessionId: string | undefined,
  explicit?: string,
): string {
  let callerSlug: string | undefined
  if (callerSessionId) {
    const desc = registry.findByIdOrName(callerSessionId)
    callerSlug = desc?.workspaceSlug
  }
  return brains.resolveWorkspaceSlug(explicit, callerSlug)
}

export function registerBrainTools(server: McpServer, opts: RegisterBrainToolsOptions): void {
  const { brains, registry, callerSessionId } = opts

  // ── workspace_brain_query ────────────────────────────────────────
  server.tool(
    "workspace_brain_query",
    "Search a workspace's 'brain' — the ingested transcripts of its agent " +
      "sessions — and get ranked keyword (BM25) hits. Use this to recall what " +
      "a workspace's sessions actually did: decisions, APIs, files touched, " +
      "problem areas. Resolves the target workspace as the explicit `workspace` " +
      "argument, else the calling session's own workspace. Returns hits with " +
      "source id, score, and a text snippet.",
    {
      query: z.string().min(1).describe("Natural-language / keyword query."),
      topK: z
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .describe("Max hits to return. Default 10."),
      workspace: z
        .string()
        .optional()
        .describe(
          "Workspace slug whose brain to query. Omit to use the calling session's workspace.",
        ),
    },
    async input => {
      const workspace = resolveTargetWorkspace(brains, registry, callerSessionId, input.workspace)
      try {
        const brain = brains.getBrain(workspace)
        const result = await brain.getProvider().query({
          query: input.query,
          ...(input.topK !== undefined ? { topK: input.topK } : {}),
        })
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ workspace, ...result }, null, 2),
            },
          ],
        }
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `workspace_brain_query failed: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true as const,
        }
      }
    },
  )

  // ── workspace_brain_status ──────────────────────────────────────
  server.tool(
    "workspace_brain_status",
    "Report how current a workspace's brain is: how many sessions are indexed, " +
      "how many known-but-pending remain, how many were skipped as permanently " +
      "unavailable (no transcript ever reachable — bash PTYs, GC'd transcripts; " +
      "retry one explicitly with `workspace_brain_ingest`'s `sessionId`), total " +
      "bytes, and whether the index is query-ready. Resolves the workspace as " +
      "the explicit `workspace` argument, else the calling session's own workspace.",
    {
      workspace: z
        .string()
        .optional()
        .describe("Workspace slug. Omit to use the calling session's workspace."),
    },
    async input => {
      const workspace = resolveTargetWorkspace(brains, registry, callerSessionId, input.workspace)
      try {
        const status = await brains.getBrain(workspace).status()
        return {
          content: [{ type: "text" as const, text: JSON.stringify(status, null, 2) }],
        }
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `workspace_brain_status failed: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true as const,
        }
      }
    },
  )

  // ── workspace_brain_ingest ──────────────────────────────────────
  server.tool(
    "workspace_brain_ingest",
    "Manually ingest conversations into a workspace's brain. When `sessionId` " +
      "is given, ingest that one session (pass `reindex:true` to re-ingest even " +
      "if already indexed); otherwise ingest every known-but-not-yet-indexed " +
      "session for the workspace. The daemon already auto-ingests on session " +
      "exit — this is for backfilling or repair.",
    {
      workspace: z
        .string()
        .optional()
        .describe("Workspace slug. Omit to use the calling session's workspace."),
      sessionId: z
        .string()
        .optional()
        .describe("Ingest one specific session (sess_xxx) instead of the backlog."),
      reindex: mcpBool
        .optional()
        .describe(
          "When `sessionId` is set and it was already ingested, force a re-ingest " +
            "from the current transcript. Default false. Pass `true` or the " +
            'string "true" to enable.',
        ),
    },
    async input => {
      const workspace = resolveTargetWorkspace(brains, registry, callerSessionId, input.workspace)
      try {
        const brain = brains.getBrain(workspace)
        if (input.sessionId) {
          const result = await brain.ingestSession(input.sessionId, input.reindex === true)
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({ workspace, result }, null, 2),
              },
            ],
            ...(result.ok ? {} : { isError: true as const }),
          }
        }
        const report = await brain.ingestPending()
        return {
          content: [{ type: "text" as const, text: JSON.stringify(report, null, 2) }],
        }
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `workspace_brain_ingest failed: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true as const,
        }
      }
    },
  )
}
