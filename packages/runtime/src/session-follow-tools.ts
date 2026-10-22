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
  FOLLOW_URGENCIES,
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
  boardId: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe(
      "Follow task-board changes: wake on a `task-changed` for a task on THIS board " +
        "(created/claimed/status/released by another actor; pure edits ignored). " +
        "Independent of the session selector.",
    ),
  rootOnly: z
    .boolean()
    .optional()
    .describe("Only sessions without a parent. Default true when `all`, else false."),
})

export const followExcludeSchema = z.object({
  sessionIds: idList.optional(),
  labels: z.array(z.string().min(1)).max(500).optional(),
})

/** The per-follow triage block, see `follow-triage.ts`. Off by default.
 *  Strict on purpose: there is no per-follow `classifier` (it executes on the
 *  daemon host: operator config only), so one is rejected, not dropped. */
export const followTriageSchema = z
  .object({
  enabled: z
    .boolean()
    .optional()
    .describe(
      "Classify each event wake/fyi/drop BEFORE a digest may wake you. " +
        "Off by default (the daemon's `follow.triage` default applies when unset).",
    ),
  rules: z
    .object({
      ownTaskChanges: z.boolean().optional().describe("Your own task-board writes → drop."),
      operatorExit: z.boolean().optional().describe("Exits you or the operator asked for → fyi."),
      cronOk: z.boolean().optional().describe("A cron run that finished OK → drop."),
      reportedTurnEnd: z
        .boolean()
        .optional()
        .describe("A turn-end right after the session reported up to you → drop."),
      emptyTurnEnd: z
        .boolean()
        .optional()
        .describe("An empty/cancelled turn-end superseded by a new turn → fyi."),
      ownPr: z.boolean().optional().describe("A PR opened by one of your own live sessions → fyi."),
    })
    .optional(),
  reportWindowMs: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("How long after a report a turn-end counts as its echo. Default 60000."),
  })
  .strict()

export const followInputSchema = z.object({
  follower: z.string().min(1).optional(),
  key: z.string().min(1).max(200).optional(),
  selector: followSelectorSchema,
  exclude: followExcludeSchema.optional(),
  events: z.array(z.enum(FOLLOW_EVENTS)).optional(),
  batchMs: z.number().int().min(0).max(MAX_FOLLOW_BATCH_MS).optional(),
  skipEmptyTurns: z.boolean().optional(),
  excludeFollowerChildren: z.boolean().optional(),
  urgency: z.enum(FOLLOW_URGENCIES).optional(),
  triage: followTriageSchema.optional(),
  expiresAt: z.string().min(1).optional(),
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
  if (
    !(sel.sessionIds && sel.sessionIds.length > 0) &&
    sel.all !== true &&
    !sel.cwdPrefix &&
    !sel.boardId
  ) {
    return {
      ok: false,
      status: 400,
      error: "invalid_selector",
      message: "selector needs at least one of: sessionIds (non-empty), all: true, cwdPrefix, boardId",
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
      ...(sel.boardId ? { boardId: sel.boardId } : {}),
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
    ...(body.urgency ? { urgency: body.urgency } : {}),
    ...(body.triage ? { triage: body.triage } : {}),
    ...(body.expiresAt ? { expiresAt: body.expiresAt } : {}),
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
      "`rootOnly: false`), or `cwdPrefix`; or a task board with `boardId` (wake " +
      "on that board's `task-changed`). `exclude` removes ids/labels. Events " +
      "are coalesced within `batchMs` into one automatic digest message that " +
      "never interrupts a busy follower. `urgency` (default \"next-turn\") sets how a " +
      "digest lands: \"next-turn\" wakes you for a turn; \"fyi\" parks it in your inbox " +
      "(unread count prefixed on your next message) and never starts a turn — use it " +
      "for high-volume follows you only need to skim. Your own events are never delivered to " +
      "you; your descendants' only with `excludeFollowerChildren: false`. Upserts by `key` when given. Survives daemon " +
      "restarts.",
    {
      follower: z.string().optional().describe("Session to wake. Defaults to the calling session."),
      key: z.string().optional().describe("Stable key: re-posting the same key updates that follow in place."),
      selector: followSelectorSchema.describe("Which sessions (or task board) to follow (need one of sessionIds / all / cwdPrefix / boardId)."),
      exclude: followExcludeSchema.optional().describe("Sessions to ignore, by id or label."),
      events: z
        .array(z.enum(FOLLOW_EVENTS))
        .optional()
        .describe("Event kinds to deliver. Default: all of turn-end, awaiting-input, exited, crashed, pr-opened, pr-merged, task-changed."),
      batchMs: z.number().int().optional().describe("Coalescing window in ms. Default 15000."),
      skipEmptyTurns: z.boolean().optional().describe("Drop silent no-op turns. Default true."),
      urgency: z
        .enum(FOLLOW_URGENCIES)
        .optional()
        .describe(
          'Digest delivery. Default "next-turn" (wakes the follower). "fyi" parks digests in the inbox without starting a turn.',
        ),
      excludeFollowerChildren: z.boolean().optional().describe(
        "Ignore the follower's own descendants. Default true. `false` delivers them " +
          "(any depth, even under `rootOnly`) — what a supervisor wants for its own children.",
      ),
      triage: followTriageSchema.optional().describe(
        "Triage each event wake/fyi/drop before a digest may wake you (off by default). " +
          "A digest whose events are all fyi/drop lands in your inbox as fyi and never " +
          "starts a turn.",
      ),
      expiresAt: z
        .string()
        .optional()
        .describe("ISO timestamp after which the follow is removed. Defaulted to 7 days from creation; an unparseable value falls back to that default. An upsert-by-key that omits it keeps the existing expiry (no implicit renewal)."),
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
