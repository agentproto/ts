/**
 * `desktop_conversation_list`: the conversations of the Claude Desktop and
 * Codex Desktop apps, read from the files those apps keep on disk.
 *
 * Until now a Desktop conversation only showed up in agentproto as the
 * `parentSessionId` (`cc:<id>` / `codex:<thread>`) of a session it had
 * spawned, and only after it had called the daemon once. This lists them all,
 * whether or not they ever did.
 *
 *   claude  ~/Library/Application Support/Claude/claude-code-sessions/<account>/<org>/local_*.json
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
  claudeSessionsDir?: string
  codexHome?: string
}

export const claudeDesktopSessionsDir = (): string =>
  join(homedir(), "Library", "Application Support", "Claude", "claude-code-sessions")

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v : undefined)
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined)

async function collectJson(dir: string, depth: number, out: string[]): Promise<void> {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    const p = join(dir, e.name)
    if (e.isDirectory() && depth > 0) await collectJson(p, depth - 1, out)
    else if (e.isFile() && e.name.startsWith("local_") && e.name.endsWith(".json")) out.push(p)
  }
}

export async function listClaudeDesktopConversations(dir: string): Promise<DesktopConversation[]> {
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

const NODE_SQLITE = "node:" + "sqlite"

export async function listCodexDesktopConversations(codexHome: string): Promise<DesktopConversation[]> {
  const dbPath = join(codexHome, "state_5.sqlite")
  try {
    await stat(dbPath)
  } catch {
    return []
  }
  const { DatabaseSync } = (await import(/* @vite-ignore */ NODE_SQLITE)) as typeof import("node:sqlite")
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
          "FROM threads ORDER BY COALESCE(updated_at_ms, updated_at * 1000) DESC",
      )
      .all() as Array<Record<string, unknown>>
    const out: DesktopConversation[] = []
    for (const r of rows) {
      const id = str(r.id)
      if (!id) continue
      const created = num(r.created_at_ms) ?? (num(r.created_at) !== undefined ? num(r.created_at)! * 1000 : undefined)
      const last = num(r.updated_at_ms) ?? (num(r.updated_at) !== undefined ? num(r.updated_at)! * 1000 : undefined)
      // `name` is what the user typed in the app; `title` is the first message.
      const title = (str(r.name) ?? str(r.title) ?? "(sans titre)").replace(/\s+/g, " ").slice(0, 200)
      out.push({
        app: "codex",
        id,
        externalId: `codex:${id}`,
        title,
        ...(str(r.cwd) ? { cwd: str(r.cwd)! } : {}),
        ...(created !== undefined ? { createdAtMs: created } : {}),
        ...(last !== undefined ? { lastActivityMs: last } : {}),
        archived: num(r.archived) === 1,
        ...(str(r.rollout_path) ? { transcriptPath: str(r.rollout_path)! } : {}),
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

export async function listDesktopConversations(opts: DesktopListOptions = {}): Promise<DesktopConversation[]> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500)
  const [claude, codex] = await Promise.all([
    opts.app === "codex" ? [] : listClaudeDesktopConversations(opts.claudeSessionsDir ?? claudeDesktopSessionsDir()),
    opts.app === "claude" ? [] : listCodexDesktopConversations(opts.codexHome ?? join(homedir(), ".codex")),
  ])
  return [...claude, ...codex]
    .filter(c => opts.includeArchived === true || !c.archived)
    .sort((a, b) => (b.lastActivityMs ?? 0) - (a.lastActivityMs ?? 0))
    .slice(0, limit)
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
      app: z.enum(["claude", "codex"]).optional().describe("Only this app. Default: both."),
      includeArchived: z.boolean().optional().describe("Also list archived chats. Default false."),
      limit: z.number().int().min(1).max(500).optional().describe("Max rows, default 50."),
    },
    async input => {
      const conversations = await listDesktopConversations(input)
      return { content: [{ type: "text" as const, text: JSON.stringify({ count: conversations.length, conversations }) }] }
    },
  )
}
