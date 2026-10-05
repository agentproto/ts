/**
 * MCP surface + shared create/remove logic for session-follow:
 * `session_follow` (upsert), `session_unfollow`, `session_follows` (list).
 *
 * `upsertSessionFollow` / `removeSessionFollow` / `followView` are exported
 * so `http-server.ts`'s `POST|GET|DELETE /follows` routes share the exact same
 * validation as the MCP tools — same pattern as `sentinel-tools.ts`.
 *
 * `session_follow`'s `follower` defaults to the calling session (the trusted
 * `?callerSessionId=` of the `/mcp` connection), like `sentinel_watch`.
 */

import { z } from "zod"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"

import {
  FOLLOW_EVENTS,
  MAX_FOLLOW_BATCH_MS,
  type SessionFollow,
  type SessionFollowInput,
  type SessionFollowStore,
} from "./session-follow-store.js"

// ── Input schema (shared by HTTP + MCP) ──────────────────────────────

const idList = z.array(z.string().min(1)).max(500)

export const followSelectorSchema = z.object({
  sessionIds: idList.optional().describe("Explicit session ids to follow."),
  all: z
    .boolean()
    .optional()
    .describe("Follow every session that exists at event time (covers sessions spawned later)."),
  cwdPrefix: z.string().min(1).optional().describe("Follow sessions whose cwd is this path or below."),
  rootOnly: z
    .boolean()
    .optional()
    .describe("Only sessions without a parent. Default true when `all`, else false."),
})

export const followExcludeSchema = z.object({
  sessionIds: idList.optional(),
  labels: z.array(z.string().min(1)).max(500).optional(),
})

export const followInputSchema = z.object({
  follower: z.string().min(1).optional(),
  key: z.string().min(1).max(200).optional(),
  selector: followSelectorSchema,
  exclude: followExcludeSchema.optional(),
  events: z.array(z.enum(FOLLOW_EVENTS)).optional(),
  batchMs: z.number().int().min(0).max(MAX_FOLLOW_BATCH_MS).optional(),
  skipEmptyTurns: z.boolean().optional(),
  excludeFollowerChildren: z.boolean().optional(),
})

export type FollowInputBody = z.infer<typeof followInputSchema>

// ── Shared upsert / remove ───────────────────────────────────────────

export interface SessionFollowDeps {
  store: SessionFollowStore
  /** True when the registry still knows this session id. */
  hasSession: (sessionId: string) => boolean
  /** Default follower when the input omits it (MCP caller's own session). */
  defaultFollower?: string
}

export type UpsertFollowResult =
  | { ok: true; follow: SessionFollow; created: boolean }
  | { ok: false; status: 400 | 404; error: string; message: string }

export function upsertSessionFollow(deps: SessionFollowDeps, raw: unknown): UpsertFollowResult {
  const parsed = followInputSchema.safeParse(raw)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    const where = issue && issue.path.length > 0 ? `${issue.path.join(".")}: ` : ""
    return { ok: false, status: 400, error: "invalid_input", message: `${where}${issue?.message ?? "invalid input"}` }
  }
  const body = parsed.data
  const follower = body.follower ?? deps.defaultFollower
  if (!follower) {
    return {
      ok: false,
      status: 400,
      error: "no_follower",
      message: "provide `follower` (no calling session identity to default to)",
    }
  }
  const sel = body.selector
  if (!(sel.sessionIds && sel.sessionIds.length > 0) && sel.all !== true && !sel.cwdPrefix) {
    return {
      ok: false,
      status: 400,
      error: "invalid_selector",
      message: "selector needs at least one of: sessionIds (non-empty), all: true, cwdPrefix",
    }
  }
  if (!deps.hasSession(follower)) {
    return { ok: false, status: 404, error: "session_not_found", message: `follower session "${follower}" not found` }
  }
  const input: SessionFollowInput = {
    follower,
    selector: {
      ...(sel.sessionIds ? { sessionIds: sel.sessionIds } : {}),
      ...(sel.all !== undefined ? { all: sel.all } : {}),
      ...(sel.cwdPrefix ? { cwdPrefix: sel.cwdPrefix } : {}),
      ...(sel.rootOnly !== undefined ? { rootOnly: sel.rootOnly } : {}),
    },
    ...(body.key ? { key: body.key } : {}),
    ...(body.exclude ? { exclude: body.exclude } : {}),
    ...(body.events ? { events: body.events } : {}),
    ...(body.batchMs !== undefined ? { batchMs: body.batchMs } : {}),
    ...(body.skipEmptyTurns !== undefined ? { skipEmptyTurns: body.skipEmptyTurns } : {}),
    ...(body.excludeFollowerChildren !== undefined
      ? { excludeFollowerChildren: body.excludeFollowerChildren }
      : {}),
  }
  const { follow, created } = deps.store.upsert(input)
  return { ok: true, follow, created }
}

/** `false` only means "no such follow" (by id or key). */
export function removeSessionFollow(
  deps: Pick<SessionFollowDeps, "store">,
  idOrKey: string,
): SessionFollow | undefined {
  return deps.store.remove(idOrKey)
}

/** The wire view of a follow — the record itself (no secrets in it). */
export function followView(follow: SessionFollow): SessionFollow {
  return follow
}

// ── MCP tools ────────────────────────────────────────────────────────

export interface RegisterSessionFollowToolsOptions {
  store: SessionFollowStore
  hasSession: (sessionId: string) => boolean
  /** Trusted `?callerSessionId=` of the connecting `/mcp` client. */
  callerSessionId?: string
}

type ToolResult = {
  content: Array<{ type: "text"; text: string }>
  isError?: boolean
}

const ok = (body: Record<string, unknown>): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify({ ok: true, ...body }) }],
})
const fail = (code: string, message: string): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify({ ok: false, error: code, message }) }],
  isError: true,
})

export function registerSessionFollowTools(server: McpServer, opts: RegisterSessionFollowToolsOptions): void {
  const { store, hasSession, callerSessionId } = opts

  server.tool(
    "session_follow",
    "Wake a session (the follower, default: you) when OTHER sessions end a " +
      "turn, await input, exit/crash, or get a PR opened/merged — no polling. " +
      "`selector` picks sessions: `sessionIds`, `all: true` (evaluated at event " +
      "time, so sessions spawned later are covered; root sessions only unless " +
      "`rootOnly: false`), or `cwdPrefix`. `exclude` removes ids/labels. Events " +
      "are coalesced within `batchMs` into one automatic digest message that " +
      "never interrupts a busy follower. Your own events and your children's " +
      "are never delivered to you. Upserts by `key` when given. Survives daemon " +
      "restarts.",
    {
      follower: z.string().optional().describe("Session to wake. Defaults to the calling session."),
      key: z.string().optional().describe("Stable key: re-posting the same key updates that follow in place."),
      selector: followSelectorSchema.describe("Which sessions to follow (need one of sessionIds / all / cwdPrefix)."),
      exclude: followExcludeSchema.optional().describe("Sessions to ignore, by id or label."),
      events: z
        .array(z.enum(FOLLOW_EVENTS))
        .optional()
        .describe("Event kinds to deliver. Default: all of turn-end, awaiting-input, exited, crashed, pr-opened, pr-merged."),
      batchMs: z.number().int().optional().describe("Coalescing window in ms. Default 15000."),
      skipEmptyTurns: z.boolean().optional().describe("Drop silent no-op turns. Default true."),
      excludeFollowerChildren: z.boolean().optional().describe("Ignore the follower's own descendants. Default true."),
    },
    async (input: Record<string, unknown>) => {
      const result = upsertSessionFollow(
        { store, hasSession, ...(callerSessionId ? { defaultFollower: callerSessionId } : {}) },
        input,
      )
      return result.ok
        ? ok({ created: result.created, follow: followView(result.follow) })
        : fail(result.error, `session_follow: ${result.message}`)
    },
  )

  server.tool(
    "session_unfollow",
    "Stop a follow by its id (fol_...) or its key. An unknown id is reported, not thrown.",
    { id: z.string().describe("Follow id (fol_...) or key.") },
    async ({ id }: { id: string }) => {
      const removed = removeSessionFollow({ store }, id)
      if (!removed) return fail("not_found", `session_unfollow: no follow "${id}"`)
      return ok({ removed: true, id: removed.id })
    },
  )

  server.tool(
    "session_follows",
    "List session follows (selector, events, batch window). Optionally only those waking one follower.",
    { follower: z.string().optional().describe("Only follows whose follower is this session.") },
    async ({ follower }: { follower?: string }) =>
      ok({ follows: store.list(follower ? { follower } : undefined).map(followView) }),
  )
}
