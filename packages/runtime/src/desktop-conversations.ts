/**
 * `desktop_conversation_list`: the conversations of the Claude Desktop and
 * Codex Desktop apps, read from the files those apps keep on disk.
 *
 * Until now a Desktop conversation only showed up in agentproto as the
 * `parentSessionId` (`cc:<id>` / `codex:<thread>`) of a session it had
 * spawned, and only after it had called the daemon once. This lists them all,
 * whether or not they ever did.
 *
 *   claude  ~/Library/Application Support/{Claude,Claude-3p}/claude-code-sessions/<account>/<org>/local_*.json
 *           (title, cliSessionId, cwd, timestamps, isArchived). Undocumented
 *           app-internal format: every field is read defensively and a file
 *           that does not parse is skipped, never fatal.
 *   codex   ~/.codex/state_5.sqlite, table `threads` (opened read-only).
 *
 * Read-only. Nothing here talks to the apps or writes to their stores.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { readdir, readFile, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { z } from "zod"
import type { ExportedSession } from "./transcript-export.js"
import type { SessionsRegistry } from "./sessions.js"
import type { MessageUrgency } from "./session-message.js"
import type { MessageSendApi } from "./message-tools.js"

export type DesktopApp = "claude" | "codex"

export interface DesktopConversation {
  app: DesktopApp
  /** The app's own conversation id: Claude's CLI session id (the jsonl name),
   *  Codex's thread id. */
  id: string
  /** The address this conversation uses when it calls the daemon
   *  (`cc:<id>` / `codex:<id>`): the key of its `external` session row. */
  externalId: string
  title: string
  cwd?: string
  createdAtMs?: number
  lastActivityMs?: number
  archived: boolean
  /** Claude only: the app's own `local_*` id. */
  appSessionId?: string
  /** Codex only: the rollout transcript path. */
  transcriptPath?: string
}

export interface DesktopListOptions {
  app?: DesktopApp
  includeArchived?: boolean
  /** Default 50, max 500. */
  limit?: number
  /** Test seams. Default to the real per-user locations. */
  claudeSessionsDirs?: string[]
  codexHome?: string
}

/** Claude Desktop keeps one data folder per build: `Claude` (standard) and
 *  `Claude-3p` (the third-party-inference build). Both use the same layout,
 *  and on a machine that runs the 3p build the `Claude` one can be stale. */
export const claudeDesktopSessionsDirs = (): string[] =>
  ["Claude", "Claude-3p"].map(app =>
    join(
      homedir(),
      "Library",
      "Application Support",
      app,
      "claude-code-sessions"
    )
  )

const str = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim() ? v : undefined
const num = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined

async function collectJson(
  dir: string,
  depth: number,
  out: string[]
): Promise<void> {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    const p = join(dir, e.name)
    if (e.isDirectory() && depth > 0) await collectJson(p, depth - 1, out)
    else if (
      e.isFile() &&
      e.name.startsWith("local_") &&
      e.name.endsWith(".json")
    )
      out.push(p)
  }
}

export async function listClaudeDesktopConversations(
  dir: string
): Promise<DesktopConversation[]> {
  const files: string[] = []
  await collectJson(dir, 3, files)
  const out: DesktopConversation[] = []
  for (const f of files) {
    let j: Record<string, unknown>
    try {
      j = JSON.parse(await readFile(f, "utf8")) as Record<string, unknown>
    } catch {
      continue
    }
    // A Desktop chat that never ran a turn has no CLI session yet: nothing
    // to address, nothing to read.
    const id = str(j.cliSessionId)
    if (!id) continue
    const cwd = str(j.cwd)
    const created = num(j.createdAt)
    const last = num(j.lastActivityAt) ?? num(j.lastFocusedAt)
    out.push({
      app: "claude",
      id,
      externalId: `cc:${id}`,
      title: str(j.title) ?? "(sans titre)",
      ...(cwd ? { cwd } : {}),
      ...(created !== undefined ? { createdAtMs: created } : {}),
      ...(last !== undefined ? { lastActivityMs: last } : {}),
      archived: j.isArchived === true,
      ...(str(j.sessionId) ? { appSessionId: str(j.sessionId)! } : {}),
    })
  }
  return out
}

/** Several data folders, one list: a chat found twice keeps its newest copy. */
export async function listClaudeDesktopConversationsIn(
  dirs: string[]
): Promise<DesktopConversation[]> {
  const byId = new Map<string, DesktopConversation>()
  for (const list of await Promise.all(
    dirs.map(listClaudeDesktopConversations)
  )) {
    for (const c of list) {
      const seen = byId.get(c.id)
      if (!seen || (c.lastActivityMs ?? 0) > (seen.lastActivityMs ?? 0))
        byId.set(c.id, c)
    }
  }
  return [...byId.values()]
}

const NODE_SQLITE = "node:" + "sqlite"

export async function listCodexDesktopConversations(
  codexHome: string
): Promise<DesktopConversation[]> {
  const dbPath = join(codexHome, "state_5.sqlite")
  try {
    await stat(dbPath)
  } catch {
    return []
  }
  const { DatabaseSync } = (await import(
    /* @vite-ignore */ NODE_SQLITE
  )) as typeof import("node:sqlite")
  let db: InstanceType<typeof DatabaseSync>
  try {
    db = new DatabaseSync(dbPath, { readOnly: true })
  } catch {
    return []
  }
  try {
    const rows = db
      .prepare(
        "SELECT id, rollout_path, cwd, title, name, archived, created_at, updated_at, created_at_ms, updated_at_ms " +
          "FROM threads ORDER BY COALESCE(updated_at_ms, updated_at * 1000) DESC"
      )
      .all() as Array<Record<string, unknown>>
    const out: DesktopConversation[] = []
    for (const r of rows) {
      const id = str(r.id)
      if (!id) continue
      const created =
        num(r.created_at_ms) ??
        (num(r.created_at) !== undefined
          ? num(r.created_at)! * 1000
          : undefined)
      const last =
        num(r.updated_at_ms) ??
        (num(r.updated_at) !== undefined
          ? num(r.updated_at)! * 1000
          : undefined)
      // `name` is what the user typed in the app; `title` is the first message.
      const title = (str(r.name) ?? str(r.title) ?? "(sans titre)")
        .replace(/\s+/g, " ")
        .slice(0, 200)
      out.push({
        app: "codex",
        id,
        externalId: `codex:${id}`,
        title,
        ...(str(r.cwd) ? { cwd: str(r.cwd)! } : {}),
        ...(created !== undefined ? { createdAtMs: created } : {}),
        ...(last !== undefined ? { lastActivityMs: last } : {}),
        archived: num(r.archived) === 1,
        ...(str(r.rollout_path)
          ? { transcriptPath: str(r.rollout_path)! }
          : {}),
      })
    }
    return out
  } catch {
    // Schema moved under us (the file is the app's, not ours): say nothing
    // rather than fail the whole list.
    return []
  } finally {
    db.close()
  }
}

export async function listDesktopConversations(
  opts: DesktopListOptions = {}
): Promise<DesktopConversation[]> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500)
  const [claude, codex] = await Promise.all([
    opts.app === "codex"
      ? []
      : listClaudeDesktopConversationsIn(
          opts.claudeSessionsDirs ?? claudeDesktopSessionsDirs()
        ),
    opts.app === "claude"
      ? []
      : listCodexDesktopConversations(
          opts.codexHome ?? join(homedir(), ".codex")
        ),
  ])
  return [...claude, ...codex]
    .filter(c => opts.includeArchived === true || !c.archived)
    .sort((a, b) => (b.lastActivityMs ?? 0) - (a.lastActivityMs ?? 0))
    .slice(0, limit)
}

export interface DesktopReadOptions extends DesktopListOptions {
  app: DesktopApp
  id: string
  /** Keep only the last N messages (default 20, max 200). */
  tail?: number
}

export interface DesktopReadResult {
  conversation: DesktopConversation
  meta: ExportedSession["meta"]
  totalMessages: number
  messages: ExportedSession["messages"]
}

/** Read one Desktop conversation's transcript. The id must be one the list
 *  returns: an unknown id is an error, never a guess. */
export async function readDesktopConversation(
  opts: DesktopReadOptions
): Promise<DesktopReadResult> {
  const tail = Math.min(Math.max(opts.tail ?? 20, 1), 200)
  const all = await listDesktopConversations({
    ...opts,
    app: opts.app,
    includeArchived: true,
    limit: 500,
  })
  const conversation = all.find(c => c.app === opts.app && c.id === opts.id)
  if (!conversation)
    throw new Error(
      `desktop_conversation_read: no ${opts.app} Desktop conversation "${opts.id}"`
    )
  const { exportClaudeCodeSession, exportCodexSession } =
    await import("./transcript-export.js")
  let session: ExportedSession
  if (conversation.app === "claude") {
    if (!conversation.cwd)
      throw new Error(
        `desktop_conversation_read: chat ${opts.id} has no cwd, cannot locate its transcript`
      )
    session = await exportClaudeCodeSession(conversation.id, conversation.cwd)
  } else {
    session = await exportCodexSession(conversation.id, opts.codexHome)
  }
  return {
    conversation,
    meta: session.meta,
    totalMessages: session.messages.length,
    messages: session.messages.slice(-tail),
  }
}

export function registerDesktopConversationListTool(server: McpServer): void {
  server.tool(
    "desktop_conversation_list",
    "List the conversations of the Claude Desktop (Code tab) and Codex Desktop apps, newest first, " +
      "read from the apps' own local stores. Each row carries `id`, the `externalId` the chat uses " +
      "when it calls the daemon (`cc:<id>` / `codex:<id>`, usable as a message_send target once the " +
      "chat has registered), title, cwd and last activity. Includes chats that never called agentproto. " +
      "Read-only; archived chats are hidden unless `includeArchived`.",
    {
      app: z
        .enum(["claude", "codex"])
        .optional()
        .describe("Only this app. Default: both."),
      includeArchived: z
        .boolean()
        .optional()
        .describe("Also list archived chats. Default false."),
      limit: z
        .number()
        .int()
        .min(1)
        .max(500)
        .optional()
        .describe("Max rows, default 50."),
    },
    async input => {
      const conversations = await listDesktopConversations(input)
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              count: conversations.length,
              conversations,
            }),
          },
        ],
      }
    }
  )
}

export function registerDesktopConversationReadTool(server: McpServer): void {
  server.tool(
    "desktop_conversation_read",
    "Read the transcript of a Claude Desktop or Codex Desktop conversation returned by " +
      "desktop_conversation_list: the last `tail` messages (default 20) plus metadata. Read-only; an id " +
      "that is not in the list is an error.",
    {
      app: z
        .enum(["claude", "codex"])
        .describe("The app the conversation belongs to."),
      id: z
        .string()
        .min(1)
        .describe("The `id` from desktop_conversation_list."),
      tail: z
        .number()
        .int()
        .min(1)
        .max(200)
        .optional()
        .describe("Last N messages, default 20."),
    },
    async input => {
      try {
        const result = await readDesktopConversation(input)
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
        }
      } catch (err) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: (err as Error).message }],
        }
      }
    }
  )
}

export type DesktopAskRegistry = Pick<SessionsRegistry, "touchExternal">
/** The send path of `message_send`: same permission decision as that tool. */
export type DesktopAskSend = MessageSendApi["sendAsCaller"]

export interface DesktopAskOptions extends DesktopListOptions {
  registry: DesktopAskRegistry
  send: DesktopAskSend
  app: DesktopApp
  id: string
  text: string
  /** Delivery tier, `next-turn` (default) or `steer`. Never `interrupt`. */
  urgency?: Extract<MessageUrgency, "fyi" | "next-turn" | "steer">
  /** How long to wait for the reply, ms. Default 60000, max 300000, 0 = send only. */
  waitMs?: number
  /** Test seams. */
  pollMs?: number
  settleMs?: number
}

export interface DesktopAskResult {
  conversation: DesktopConversation
  messageId: string
  delivered: unknown
  /** The assistant text produced after the message arrived, or null. */
  reply: string | null
  note?: string
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

/**
 * Ask a Claude Desktop conversation: send `text` to its `cc:<id>` address and
 * read its answer from the transcript.
 *
 * Delivery is the daemon's own external path: a direct wake over the chat's
 * Claude Code socket when `daemon.claudeSocketWake` is on and the chat's
 * process is alive, otherwise the message waits in the chat's inbox until its
 * next hook poll. `delivered.via` says which; a parked message normally
 * produces no reply inside `waitMs`, and the result says so instead of
 * pretending. The reply is the assistant text that appears in the transcript
 * after the send and has stopped growing for `settleMs`.
 */
export async function askDesktopConversation(
  opts: DesktopAskOptions
): Promise<DesktopAskResult> {
  if (opts.app !== "claude") {
    throw new Error(
      "desktop_conversation_ask: only Claude Desktop is supported so far (Codex comes in a later change)"
    )
  }
  const before = await readDesktopConversation({ ...opts, tail: 1 })
  const { conversation } = before
  opts.registry.touchExternal({
    id: conversation.externalId,
    host: "claude-desktop",
    name: conversation.title,
    ...(conversation.cwd ? { cwd: conversation.cwd } : {}),
    ...(conversation.appSessionId
      ? { hostSessionId: conversation.appSessionId }
      : {}),
  })
  const toolResult = await opts.send(
    "desktop_conversation_ask",
    conversation.externalId,
    {
      text: opts.text,
      kind: "question",
      urgency: opts.urgency ?? "next-turn",
    }
  )
  const sent = JSON.parse(toolResult.content[0]!.text) as {
    ok: boolean
    message?: string
    messageId?: string
    delivered?: unknown
  }
  // A refusal (permissions, no caller identity, ...) is the answer: surfaced as is, nothing is sent.
  if (toolResult.isError || !sent.ok)
    throw new Error(sent.message ?? "desktop_conversation_ask: send refused")
  const base: DesktopAskResult = {
    conversation,
    messageId: sent.messageId ?? "",
    delivered: sent.delivered,
    reply: null,
  }
  const waitMs = Math.min(Math.max(opts.waitMs ?? 60_000, 0), 300_000)
  if (waitMs === 0) return base
  const pollMs = opts.pollMs ?? 1_000
  const settleMs = opts.settleMs ?? 3_000
  const deadline = Date.now() + waitMs
  let lastCount = before.totalMessages
  let lastChange = Date.now()
  while (Date.now() < deadline) {
    await sleep(pollMs)
    const now = await readDesktopConversation({ ...opts, tail: 200 })
    if (now.totalMessages !== lastCount) {
      lastCount = now.totalMessages
      lastChange = Date.now()
    }
    const fresh = now.messages.slice(
      -(now.totalMessages - before.totalMessages) || undefined
    )
    const grew = now.totalMessages > before.totalMessages
    const lastIsAssistant =
      now.messages[now.messages.length - 1]?.role === "assistant"
    if (grew && lastIsAssistant && Date.now() - lastChange >= settleMs) {
      const reply = fresh
        .filter(m => m.role === "assistant" && m.text)
        .map(m => m.text)
        .join("\n\n")
      return { ...base, reply: reply || null }
    }
  }
  return {
    ...base,
    note:
      (sent.delivered as { via?: string } | null)?.via === "inbox"
        ? "parked in the chat's inbox (no live wake): the chat reads it at its next hook poll, no reply yet"
        : `no finished reply within ${waitMs} ms`,
  }
}

export function registerDesktopConversationAskTool(
  server: McpServer,
  ops: { registry: DesktopAskRegistry; send: DesktopAskSend }
): void {
  server.tool(
    "desktop_conversation_ask",
    "Ask a Claude Desktop conversation from desktop_conversation_list: sends your text to it and waits for " +
      "its answer. Delivery is a direct wake over the chat's Claude Code socket when `daemon.claudeSocketWake` " +
      "is on and the chat is alive, else the message is parked in its inbox and the chat reads it at its " +
      "next hook poll (`delivered.via` tells which; no reply then). Only app `claude` for now. `waitMs` 0 = send only.",
    {
      app: z.enum(["claude", "codex"]),
      id: z
        .string()
        .min(1)
        .describe("The `id` from desktop_conversation_list."),
      text: z.string().min(1).max(20_000),
      urgency: z
        .enum(["fyi", "next-turn", "steer"])
        .optional()
        .describe("Default next-turn. fyi never wakes."),
      waitMs: z
        .number()
        .int()
        .min(0)
        .max(300_000)
        .optional()
        .describe("Wait for the reply, default 60000."),
    },
    async input => {
      try {
        const result = await askDesktopConversation({
          ...input,
          registry: ops.registry,
          send: ops.send,
        })
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
        }
      } catch (err) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: (err as Error).message }],
        }
      }
    }
  )
}
