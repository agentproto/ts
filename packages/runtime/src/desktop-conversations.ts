/**
 * `desktop_conversation_list`: the conversations of the Claude Desktop and
 * Codex Desktop apps, read from the files those apps keep on disk.
 *
 * Until now a Desktop conversation only showed up in agentproto as the
 * `parentSessionId` (`cc:<id>` / `codex:<thread>`) of a session it had
 * spawned, and only after it had called the daemon once. This lists them
 * whether or not they ever called it. A Claude chat that has not run a turn
 * yet has no CLI session, so it is not listed (nothing to address or read).
 *
 *   claude  ~/Library/Application Support/{Claude,Claude-3p}/claude-code-sessions/<account>/<org>/local_*.json
 *           (title, cliSessionId, cwd, timestamps, isArchived). Undocumented
 *           app-internal format: every field is read defensively and a file
 *           that does not parse is skipped, never fatal.
 *   codex   ~/.codex/state_5.sqlite, table `threads` (opened read-only). The
 *           file name carries the app's schema version and changes when Codex
 *           bumps it: a rename yields no Codex rows, not an error.
 *
 * Read-only. Nothing here talks to the apps or writes to their stores.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { spawn } from "node:child_process"
import { readdir, readFile, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { isAbsolute, join } from "node:path"
import { z } from "zod"
import type { ExportedSession } from "./transcript-export.js"
import type { SessionsRegistry } from "./sessions.js"
import type { MessageUrgency } from "./session-message.js"
import type { MessageSendApi } from "./message-tools.js"
import { claudeCodeProjectDir } from "./conversation-store.js"
import { createWorkspaceOfCwd } from "./workspace-binding.js"

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
  // Codex is a best-effort half: `node:sqlite` is missing before Node 22.5
  // (the repo supports 20.9), and that must not fail the Claude half.
  let DatabaseSync: typeof import("node:sqlite").DatabaseSync
  try {
    ;({ DatabaseSync } = (await import(
      /* @vite-ignore */ NODE_SQLITE
    )) as typeof import("node:sqlite"))
  } catch {
    return []
  }
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
  /** Keep only the last N messages (default 20). The MCP tool caps it at 200. */
  tail?: number
  /** Already resolved conversation: skips the re-list (the ask poll loop reads many times). */
  conversation?: DesktopConversation
}

/** The fields the list/read need, picked out of the (much larger) ask options. */
function lastNonSystemRole(messages: ExportedSession["messages"]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i]!.role !== "system") return messages[i]!.role
  return undefined
}

function readScope(opts: DesktopAskOptions | DesktopReadOptions, tail: number): DesktopReadOptions {
  return {
    app: opts.app,
    id: opts.id,
    tail,
    ...(opts.claudeSessionsDirs ? { claudeSessionsDirs: opts.claudeSessionsDirs } : {}),
    ...(opts.codexHome ? { codexHome: opts.codexHome } : {}),
  }
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
  const tail = Math.max(opts.tail ?? 20, 1)
  const conversation =
    opts.conversation ??
    (
      await listDesktopConversations({
        app: opts.app,
        includeArchived: true,
        limit: 500,
        ...(opts.claudeSessionsDirs ? { claudeSessionsDirs: opts.claudeSessionsDirs } : {}),
        ...(opts.codexHome ? { codexHome: opts.codexHome } : {}),
      })
    ).find(c => c.app === opts.app && c.id === opts.id)
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
      "Read-only; archived chats are hidden unless `includeArchived`. A Claude chat that has not run a turn yet is not listed.",
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
  /** Resolves a cwd to a registered workspace slug. Defaults to the daemon's
   *  own workspaces config. A conversation is stamped with its workspace so
   *  the same-workspace rule in `message_send`'s permission decision binds. */
  workspaceOfCwd?: (cwd: string) => string | undefined
  /** Test seams. */
  pollMs?: number
  settleMs?: number
}

export interface DesktopAskResult {
  conversation: DesktopConversation
  messageId: string
  delivered: unknown
  /** Codex only: outcome of the Desktop wake (`accepted` | `unavailable` | `busy` | `uncertain`), when attempted. */
  desktopWake?: string
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
  const before = await readDesktopConversation(readScope(opts, 1))
  const { conversation } = before
  // Stamp the workspace the chat runs in: without it the external row has no
  // workspace and `message_send`'s default same-workspace rule can never bind,
  // so every session caller outside the chat's own tree is refused.
  const workspaceSlug = conversation.cwd
    ? (opts.workspaceOfCwd ?? createWorkspaceOfCwd())(conversation.cwd)
    : undefined
  opts.registry.touchExternal({
    id: conversation.externalId,
    host: opts.app === "codex" ? "codex" : "claude-desktop",
    name: conversation.title,
    ...(conversation.cwd ? { cwd: conversation.cwd } : {}),
    ...(conversation.appSessionId
      ? { hostSessionId: conversation.appSessionId }
      : {}),
    ...(workspaceSlug ? { workspaceSlug } : {}),
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
    error?: string
    message?: string
    messageId?: string
    delivered?: unknown
    desktopWake?: string
  }
  // A refusal (permissions, no caller identity, ...) is the answer: surfaced as is, nothing is sent.
  if (toolResult.isError || !sent.ok) {
    const refused = sent.message ?? "desktop_conversation_ask: send refused"
    const hint =
      sent.error === "forbidden_recipient"
        ? ` (a session caller must share this chat's workspace${workspaceSlug ? ` "${workspaceSlug}"` : ""}, or hold a grant / peer group that allows it — see permissions_explain)`
        : ""
    throw new Error(`${refused}${hint}`)
  }
  const base: DesktopAskResult = {
    conversation,
    messageId: sent.messageId ?? "",
    delivered: sent.delivered,
    ...(sent.desktopWake ? { desktopWake: sent.desktopWake } : {}),
    reply: null,
  }
  const waitMs = Math.min(Math.max(opts.waitMs ?? 60_000, 0), 300_000)
  if (waitMs === 0) return base
  const pollMs = opts.pollMs ?? 1_000
  const settleMs = opts.settleMs ?? 3_000
  const deadline = Date.now() + waitMs
  const transcriptPath =
    conversation.transcriptPath ??
    (opts.app === "claude" && conversation.cwd
      ? join(claudeCodeProjectDir(conversation.cwd), `${conversation.id}.jsonl`)
      : undefined)
  let lastCount = before.totalMessages
  // Re-parsing the transcript store on every tick is wasteful on a long wait.
  // Stat the jsonl instead: only once its size has stopped changing for
  // `settleMs` is the (single) full read taken. When the file cannot be
  // stat'd, fall back to the per-tick read.
  let seenSize = -1
  let readSize = -1
  let lastChange = Date.now()
  while (Date.now() < deadline) {
    await sleep(pollMs)
    // `settled` means the jsonl itself has been quiet for `settleMs`, so the
    // single read below already reflects the finished reply and needs no
    // further message-count settling.
    let settled = false
    if (transcriptPath) {
      let size: number | undefined
      try {
        size = (await stat(transcriptPath)).size
      } catch {
        size = undefined
      }
      if (size !== undefined) {
        if (size !== seenSize) {
          seenSize = size
          lastChange = Date.now()
          continue
        }
        if (size === readSize) continue
        if (Date.now() - lastChange < settleMs) continue
        settled = true
      }
    }
    // No tail cap here: a turn can add more than 200 messages, and the reply is all of them.
    const now = await readDesktopConversation({ ...readScope(opts, Number.MAX_SAFE_INTEGER), conversation })
    if (settled) readSize = seenSize
    if (now.totalMessages !== lastCount) {
      lastCount = now.totalMessages
      if (!settled) lastChange = Date.now()
    }
    const added = now.totalMessages - before.totalMessages
    const grew = added > 0
    const fresh = grew ? now.messages.slice(-added) : []
    // A transcript can end on a system / summary line after the answer: judge by
    // the last message that is not a system one.
    const lastIsAssistant = lastNonSystemRole(now.messages) === "assistant"
    if (
      grew &&
      lastIsAssistant &&
      (settled || Date.now() - lastChange >= settleMs)
    ) {
      const reply = fresh
        .filter(m => m.role === "assistant" && m.text)
        .map(m => m.text)
        .join("\n\n")
      return { ...base, reply: reply || null }
    }
  }
  return {
    ...base,
    note: parkedNote(opts.app, opts.urgency ?? "next-turn", sent.delivered, sent.desktopWake, waitMs),
  }
}

function parkedNote(
  app: DesktopApp,
  urgency: string,
  delivered: unknown,
  desktopWake: string | undefined,
  waitMs: number,
): string {
  if ((delivered as { via?: string } | null)?.via !== "inbox") return `no finished reply within ${waitMs} ms`
  if (app === "claude") {
    return "parked in the chat's inbox (no live wake): the chat reads it at its next hook poll, no reply yet"
  }
  if (desktopWake === "accepted") return `Codex Desktop accepted the wake but wrote no finished reply within ${waitMs} ms`
  if (desktopWake) return `parked in the thread's inbox: the Codex Desktop wake answered "${desktopWake}", so no turn was started`
  return urgency !== "next-turn"
    ? "parked in the thread's inbox: only a next-turn message can wake Codex Desktop"
    : "parked in the thread's inbox: no Codex Desktop wake was attempted (the thread id is not in daemon.codexDesktopWakeThreadIds)"
}

export function registerDesktopConversationAskTool(
  server: McpServer,
  ops: {
    registry: DesktopAskRegistry
    send: DesktopAskSend
    workspaceOfCwd?: DesktopAskOptions["workspaceOfCwd"]
  }
): void {
  server.tool(
    "desktop_conversation_ask",
    "Ask a Claude Desktop or Codex Desktop conversation from desktop_conversation_list: sends your text to it and waits for " +
      "its answer. Delivery is a direct wake over the chat's Claude Code socket when `daemon.claudeSocketWake` " +
      "is on and the chat is alive, else the message is parked in its inbox and the chat reads it at its " +
      "next hook poll (`delivered.via` tells which; no reply then). Codex: only a `next-turn` message to a thread listed in `daemon.codexDesktopWakeThreadIds` starts a turn, otherwise it is parked. `waitMs` 0 = send only.",
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
          ...(ops.workspaceOfCwd ? { workspaceOfCwd: ops.workspaceOfCwd } : {}),
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

export interface CodexCreateOptions {
  /** Absolute directory the new thread works in. */
  cwd: string
  /** First message of the new conversation. */
  prompt: string
  model?: string
  /** Default `read-only`: creating a conversation never grants write access on its own. */
  sandbox?: "read-only" | "workspace-write"
  /** How long to wait for the first turn to end, ms. Default 120000, max 600000. */
  timeoutMs?: number
  /** Time between SIGTERM and SIGKILL on a timeout, ms. Default 2000.
   *  A non-finite or negative value falls back to that default; 0 is allowed
   *  and means SIGKILL immediately. */
  killGraceMs?: number
  /** Test seam: replaces `spawn`. */
  spawnFn?: typeof spawn
  codexBin?: string
  /** Models Codex completed turns with on this account, most recent first.
   *  Only consulted to explain a "model not supported" refusal. Default: read
   *  from `<codexHome>/state_5.sqlite`. */
  workingModels?: () => Promise<string[]>
  codexHome?: string
}

/** Fallback named in the "not supported" error when no thread history is readable. */
const FALLBACK_WORKING_MODELS = ["gpt-5.6-terra"]

/** Models whose Codex threads consumed tokens (so a turn really ran), newest first. */
export async function recentCodexWorkingModels(codexHome: string): Promise<string[]> {
  const dbPath = join(codexHome, "state_5.sqlite")
  try {
    await stat(dbPath)
    const { DatabaseSync } = (await import(/* @vite-ignore */ NODE_SQLITE)) as typeof import("node:sqlite")
    const db = new DatabaseSync(dbPath, { readOnly: true })
    try {
      const rows = db
        .prepare(
          "SELECT model FROM threads WHERE model IS NOT NULL AND model != '' AND tokens_used > 0 " +
            "GROUP BY model ORDER BY MAX(COALESCE(updated_at_ms, updated_at * 1000)) DESC LIMIT 6"
        )
        .all() as Array<{ model?: unknown }>
      return rows.map(r => str(r.model)).filter((m): m is string => !!m)
    } finally {
      db.close()
    }
  } catch {
    return []
  }
}

async function explainModelRefusal(message: string, opts: CodexCreateOptions): Promise<string> {
  // Only the Codex "<model> model is not supported" shape: an unrelated
  // "... not supported" failure is passed through untouched.
  if (!/\bmodel\b[^.\n]{0,80}\bnot supported\b/i.test(message)) return message
  const refused = message.match(/['"`]([\w.:-]+)['"`]\s+model\b/i)?.[1]
  const history = await (opts.workingModels ?? (() => recentCodexWorkingModels(opts.codexHome ?? join(homedir(), ".codex"))))().catch(
    () => [] as string[]
  )
  const works = [...new Set([...history, ...FALLBACK_WORKING_MODELS])].filter(m => m !== refused)
  return (
    `${message} ` +
    (opts.model
      ? `The model "${opts.model}" is refused by this Codex account. `
      : `No \`model\` was given, so Codex used the model of its own config${refused ? ` ("${refused}")` : ""}, which this account refuses. `) +
    `Models that worked on this account: ${works.join(", ")}. Pass \`model\` (e.g. "${works[0]}") or fix \`model\` in ~/.codex/config.toml.`
  )
}

export interface CodexCreateResult {
  threadId: string | null
  /** The address the new thread uses when it calls the daemon. */
  externalId: string | null
  status: "completed" | "failed" | "timeout"
  /** The assistant's first answer, when the turn completed. */
  reply: string | null
  error?: string
  note: string
}

/**
 * Create a new Codex conversation with `codex exec --json` and return its
 * thread id. The thread lands in the same store (`~/.codex/state_5.sqlite`)
 * `desktop_conversation_list` reads, so it can be listed, read and asked
 * afterwards. It is recorded with source `exec`, not as a thread typed in the
 * Desktop app: whether the app shows it in its sidebar is not guaranteed.
 */
export async function createCodexConversation(opts: CodexCreateOptions): Promise<CodexCreateResult> {
  if (!isAbsolute(opts.cwd)) throw new Error("desktop_conversation_create: cwd must be an absolute path")
  if (!(await stat(opts.cwd).then(st => st.isDirectory(), () => false))) {
    throw new Error(`desktop_conversation_create: cwd "${opts.cwd}" is not a directory`)
  }
  const timeoutMs = Math.min(Math.max(opts.timeoutMs ?? 120_000, 1_000), 600_000)
  const args = [
    "exec",
    "--json",
    "--skip-git-repo-check",
    "-s",
    opts.sandbox ?? "read-only",
    ...(opts.model ? ["-m", opts.model] : []),
    "-C",
    opts.cwd,
    "-",
  ]
  const child = (opts.spawnFn ?? spawn)(opts.codexBin ?? "codex", args, { stdio: ["pipe", "pipe", "pipe"] })
  let threadId: string | null = null
  let reply: string | null = null
  let error: string | undefined
  let finished: "completed" | "failed" | undefined
  let buf = ""
  const onLine = (line: string) => {
    let ev: { type?: string; thread_id?: string; item?: { type?: string; text?: string }; error?: { message?: string }; message?: string }
    try {
      ev = JSON.parse(line)
    } catch {
      return
    }
    if (ev.type === "thread.started" && typeof ev.thread_id === "string") threadId = ev.thread_id
    else if (ev.type === "item.completed" && ev.item?.type === "agent_message" && ev.item.text) reply = ev.item.text
    else if (ev.type === "turn.completed") finished = "completed"
    else if (ev.type === "turn.failed") {
      finished = "failed"
      error = ev.error?.message ?? "turn failed"
    }
  }
  child.stdout?.on("data", (chunk: Buffer | string) => {
    buf += chunk.toString()
    let i: number
    while ((i = buf.indexOf("\n")) >= 0) {
      onLine(buf.slice(0, i))
      buf = buf.slice(i + 1)
    }
  })
  child.stdin?.end(opts.prompt)
  const defaultKillGraceMs = 2_000
  // Guard a public option whose value becomes a setTimeout delay: a non-finite
  // or negative one would silently mean "SIGKILL at once". 0 stays legal.
  const killGraceMs =
    typeof opts.killGraceMs === "number" && Number.isFinite(opts.killGraceMs) && opts.killGraceMs >= 0
      ? Math.max(opts.killGraceMs, 0)
      : defaultKillGraceMs
  const exit = await new Promise<"exit" | "timeout" | "spawn-error">(resolve => {
    let timedOut = false
    // Hoisted above `clear()`: `clear()` closes over it, and a synchronous call
    // before the assignment below would otherwise hit the temporal dead zone.
    let timer: ReturnType<typeof setTimeout> | undefined
    let killTimer: ReturnType<typeof setTimeout> | undefined
    let hardTimer: ReturnType<typeof setTimeout> | undefined
    const clear = () => {
      clearTimeout(timer)
      clearTimeout(killTimer)
      clearTimeout(hardTimer)
    }
    // A timeout stops the child for real: SIGTERM, then SIGKILL after a grace
    // period, and the call returns only once the child has closed (with a last
    // resort so a held-open pipe cannot hang the tool).
    timer = setTimeout(() => {
      timedOut = true
      child.kill("SIGTERM")
      killTimer = setTimeout(() => {
        child.kill("SIGKILL")
        hardTimer = setTimeout(() => resolve("timeout"), 1_000)
      }, killGraceMs)
    }, timeoutMs)
    child.once("error", err => {
      clear()
      error = (err as Error).message
      resolve("spawn-error")
    })
    child.once("close", () => {
      clear()
      resolve(timedOut ? "timeout" : "exit")
    })
  })
  if (buf.trim()) onLine(buf)
  const externalId = threadId ? `codex:${threadId}` : null
  if (exit === "spawn-error") {
    return { threadId, externalId, status: "failed", reply: null, ...(error ? { error } : {}), note: "could not start the codex CLI" }
  }
  if (exit === "timeout") {
    return {
      threadId,
      externalId,
      status: "timeout",
      reply,
      note: `the first turn did not end within ${timeoutMs} ms; it was stopped${threadId ? ", the thread exists" : ""}`,
    }
  }
  const status = finished ?? "failed"
  const failure = status === "failed" ? await explainModelRefusal(error ?? "codex exec ended without a finished turn", opts) : undefined
  return {
    threadId,
    externalId,
    status,
    reply: status === "completed" ? reply : null,
    ...(failure ? { error: failure } : {}),
    note:
      status === "completed"
        ? "created through `codex exec` (source exec): listed and readable through the desktop_conversation_* tools; the Desktop sidebar may not show it"
        : "the thread was created but its first turn failed",
  }
}

export function registerDesktopConversationCreateTool(
  server: McpServer,
  ops: {
    /** Where the new thread is registered, with its creator as owner. */
    registry?: DesktopAskRegistry
    /** The attested calling session: becomes the thread's owner. Absent: no owner. */
    callerSessionId?: string
    workspaceOfCwd?: DesktopAskOptions["workspaceOfCwd"]
    /** Test seam. */
    codexBin?: string
  } = {},
): void {
  server.tool(
    "desktop_conversation_create",
    "Create a new Codex conversation from agentproto: runs `codex exec` with your first message in `cwd` " +
      "and returns the new thread id (`codex:<id>`) and its first answer. Codex only: Claude Desktop has no " +
      "supported way to create a chat from outside the app. Runs read-only unless you ask `workspace-write`; " +
      "`cwd` may be any absolute path and `workspace-write` is not scoped to agentproto workspaces: it can write " +
      "anywhere the daemon user can. " +
      "The thread is stored as a `codex exec` thread: the Desktop sidebar may not show it, but " +
      "desktop_conversation_list / read / ask can reach it.",
    {
      app: z.enum(["codex", "claude"]),
      cwd: z.string().min(1).describe("Absolute working directory."),
      prompt: z.string().min(1).max(20_000).describe("The first message."),
      model: z.string().min(1).max(100).optional(),
      sandbox: z.enum(["read-only", "workspace-write"]).optional().describe("Default read-only."),
      timeoutMs: z.number().int().min(1_000).max(600_000).optional().describe("Default 120000."),
    },
    async input => {
      if (input.app !== "codex") {
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text:
                "desktop_conversation_create: Claude Desktop cannot create a chat from outside the app. " +
                "A `claude -p` session is not shown in its Code tab; start a daemon session with agent_start instead.",
            },
          ],
        }
      }
      try {
        const { app: _app, ...rest } = input
        const result = await createCodexConversation({ ...rest, ...(ops.codexBin ? { codexBin: ops.codexBin } : {}) })
        // The creator owns what it created: record it so a later
        // desktop_conversation_ask passes the messaging ACL (parent relation),
        // while every other session is still refused.
        if (result.externalId && ops.registry && ops.callerSessionId) {
          const slug = (ops.workspaceOfCwd ?? createWorkspaceOfCwd())(rest.cwd)
          ops.registry.touchExternal({
            id: result.externalId,
            host: "codex",
            cwd: rest.cwd,
            hostSessionId: result.threadId ?? undefined,
            ownerSessionId: ops.callerSessionId,
            ...(slug ? { workspaceSlug: slug } : {}),
          })
        }
        // A failed or timed-out creation is an error result, like `ask`'s failures.
        return {
          ...(result.status !== "completed" ? { isError: true } : {}),
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
        }
      } catch (err) {
        return { isError: true, content: [{ type: "text" as const, text: (err as Error).message }] }
      }
    },
  )
}
