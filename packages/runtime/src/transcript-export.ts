/**
 * Export a clean, readable transcript, dispatched between two kinds of
 * source:
 *
 *   native — the adapter's OWN persistence, re-read after the fact:
 *     claude-code            — ~/.claude/projects/<cwd-encoded>/<sessionId>.jsonl
 *     hermes                 — ~/.hermes/state.db via node:sqlite (read-only)
 *     codex                  — $CODEX_HOME/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl
 *     opencode               — ~/.local/share/opencode/opencode.db via node:sqlite
 *     mastracode-inprocess   — ~/.agentproto/mastracode-inprocess/storage.db (Mastra libsql)
 *     pi                     — ~/.pi/agent/sessions/<cwd-slug>/<ts>_<uuid>.jsonl
 *   daemon — agentproto's own capture, `~/.agentproto/sessions/<id>/events.jsonl`
 *     (written by transcript-writer.ts at the same point `projectEvent`
 *     flattens events into the ANSI ring buffer, ahead of that flattening).
 *     Available for ANY agent-cli session (acp or print protocol), not just
 *     the two adapters with a native store.
 *
 * `source: "auto"` (the default) tries native first and falls back to
 * daemon events when there's no native strategy or its store can't be
 * read; `"native"` / `"daemon"` force one and surface its own error.
 *
 * Output: Markdown (default) or JSON, built from a shared ExportedSession
 * model so every source produces identical rendering logic.
 */

import { createReadStream, promises as fs, type Dirent } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { createInterface } from "node:readline"
import type { SessionDescriptor, SessionsRegistry } from "./sessions.js"
import { formatToolCall } from "./tool-presenter.js"
import { sessionEventsPath } from "./transcript-writer.js"
import { claudeProjectSlug } from "./conversation-store.js"
import type { ConversationCandidate } from "./conversation-store.js"

// ── Common model ──────────────────────────────────────────────────────

export interface ExportedMessage {
  role: "user" | "assistant" | "tool" | "system"
  text?: string
  reasoning?: string
  toolName?: string
  toolCalls?: { name: string; args: string }[]
  ts?: number
}

export interface ExportedSessionMeta {
  title?: string
  model?: string
  startedAt?: string
  endedAt?: string
  messageCount?: number
  toolCallCount?: number
  tokens?: {
    input?: number
    output?: number
    cacheRead?: number
    cacheWrite?: number
    reasoning?: number
    contextSize?: number
    contextUsed?: number
  }
  costUsd?: number
  source?: string
}

export interface ExportedSession {
  meta: ExportedSessionMeta
  messages: ExportedMessage[]
}

// ── Render ────────────────────────────────────────────────────────────

const ROLE_ICON: Record<string, string> = {
  user: "🧑 User",
  assistant: "🤖 Assistant",
  tool: "🔧 Tool",
  system: "⚙️ System",
}

function trunc(text: string, n: number): string {
  if (text.length <= n) return text
  return text.slice(0, n) + `\n… [${text.length - n} chars truncated]`
}

export function renderMarkdown(
  session: ExportedSession,
  opts: { maxToolChars?: number } = {},
): string {
  const { meta, messages } = session
  const maxToolChars = opts.maxToolChars ?? 1200
  const out: string[] = []

  out.push(`# ${meta.title ?? "(untitled)"}`)
  out.push("")

  const sourceNote = meta.source ? ` · source \`${meta.source}\`` : ""
  out.push(`> Session${sourceNote}`)
  out.push("")
  out.push("| | |")
  out.push("|---|---|")
  if (meta.model) out.push(`| Model | \`${meta.model}\` |`)
  if (meta.startedAt || meta.endedAt) {
    out.push(`| Start → end | ${meta.startedAt ?? "?"} → ${meta.endedAt ?? "?"} |`)
  }
  if (meta.messageCount !== undefined || meta.toolCallCount !== undefined) {
    const parts: string[] = []
    if (meta.messageCount !== undefined) parts.push(`${meta.messageCount} messages`)
    if (meta.toolCallCount !== undefined) parts.push(`${meta.toolCallCount} tool calls`)
    out.push(`| Count | ${parts.join(" · ")} |`)
  }
  if (meta.tokens && Object.keys(meta.tokens).length) {
    const t = meta.tokens
    const parts: string[] = []
    if (t.input !== undefined) parts.push(`in ${t.input.toLocaleString("en-US")}`)
    if (t.output !== undefined) parts.push(`out ${t.output.toLocaleString("en-US")}`)
    if (t.cacheRead !== undefined || t.cacheWrite !== undefined) {
      parts.push(
        `cache r/w ${(t.cacheRead ?? 0).toLocaleString("en-US")}/${(t.cacheWrite ?? 0).toLocaleString("en-US")}`,
      )
    }
    if (t.reasoning !== undefined) parts.push(`reason. ${t.reasoning.toLocaleString("en-US")}`)
    if (parts.length) out.push(`| Tokens | ${parts.join(" · ")} |`)
  }
  if (meta.costUsd !== undefined) {
    out.push(`| Cost | $${meta.costUsd.toFixed(4)} |`)
  }
  out.push("")
  out.push("---")
  out.push("")

  for (const m of messages) {
    const icon = ROLE_ICON[m.role] ?? m.role
    const nameSuffix = m.toolName ? ` · \`${m.toolName}\`` : ""
    out.push(`### ${icon}${nameSuffix}`)

    if (m.reasoning?.trim()) {
      out.push("")
      out.push("<details><summary>💭 reasoning</summary>")
      out.push("")
      out.push(trunc(m.reasoning, 4000))
      out.push("")
      out.push("</details>")
    }

    if (m.text?.trim()) {
      out.push("")
      if (m.role === "tool") {
        out.push("```")
        out.push(trunc(m.text, maxToolChars))
        out.push("```")
      } else {
        out.push(m.text.trim())
      }
    }

    if (m.toolCalls?.length) {
      out.push("")
      for (const tc of m.toolCalls) {
        let parsedArgs: unknown
        try {
          parsedArgs = JSON.parse(tc.args)
        } catch {
          parsedArgs = tc.args
        }
        out.push(`> 📞 ${formatToolCall(tc.name, parsedArgs)}`)
      }
    }

    out.push("")
  }

  return out.join("\n")
}

export function renderJson(session: ExportedSession): string {
  return JSON.stringify(session, null, 2)
}

// ── Exporter interface ────────────────────────────────────────────────

interface ExportStrategy {
  exportSession(adapterSessionId: string, cwd?: string): Promise<ExportedSession>
}

// ── claude-code exporter (JSONL) ──────────────────────────────────────

interface ClaudeTextBlock {
  type: "text"
  text: string
}
interface ClaudeThinkingBlock {
  type: "thinking"
  thinking: string
}
interface ClaudeToolUseBlock {
  type: "tool_use"
  name: string
  input?: unknown
}
interface ClaudeToolResultBlock {
  type: "tool_result"
  tool_use_id?: string
  content?: unknown
}
type ClaudeContentBlock =
  | ClaudeTextBlock
  | ClaudeThinkingBlock
  | ClaudeToolUseBlock
  | ClaudeToolResultBlock
  | { type: string }

interface ClaudeCodeJsonlLine {
  type: string
  message?: {
    role?: string
    content?: string | ClaudeContentBlock[]
  }
}

const IGNORED_CLAUDE_TYPES = new Set([
  "queue-operation",
  "attachment",
  "file-history-snapshot",
  "ai-title",
  "last-prompt",
])

export async function exportClaudeCodeSession(
  adapterSessionId: string,
  cwd?: string,
): Promise<ExportedSession> {
  if (!cwd) {
    throw new Error(
      "claude-code exporter: cwd is required to locate the JSONL file.\n" +
        "Pass cwd explicitly or use a session id that is in the registry.",
    )
  }
  const encoded = claudeProjectSlug(cwd)
  const filePath = join(homedir(), ".claude", "projects", encoded, `${adapterSessionId}.jsonl`)

  let stream: ReturnType<typeof createReadStream>
  try {
    stream = createReadStream(filePath, { encoding: "utf8" })
    // Trigger ENOENT eagerly before readline wraps it.
    await new Promise<void>((resolve, reject) => {
      stream.once("error", reject)
      stream.once("open", resolve)
    })
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === "ENOENT") {
      throw new Error(
        `claude-code: JSONL file not found: ${filePath}\n` +
          `Verify cwd="${cwd}" and adapterSessionId="${adapterSessionId}".`,
      )
    }
    throw err
  }

  const messages: ExportedMessage[] = []
  const rl = createInterface({ input: stream, crlfDelay: Infinity })

  for await (const line of rl) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let entry: ClaudeCodeJsonlLine
    try {
      entry = JSON.parse(trimmed) as ClaudeCodeJsonlLine
    } catch {
      continue
    }
    if (IGNORED_CLAUDE_TYPES.has(entry.type)) continue
    if (entry.type !== "user" && entry.type !== "assistant") continue
    const msg = entry.message
    if (!msg) continue

    const role: ExportedMessage["role"] =
      msg.role === "assistant" ? "assistant" : "user"
    const content = msg.content

    if (typeof content === "string") {
      if (content.trim()) messages.push({ role, text: content.trim() })
      continue
    }
    if (!Array.isArray(content)) continue

    // Collect all block types from this message event
    let textAcc = ""
    let reasoningAcc = ""
    const toolCalls: { name: string; args: string }[] = []
    const toolResults: { text: string }[] = []

    for (const block of content) {
      switch (block.type) {
        case "text": {
          textAcc += (block as ClaudeTextBlock).text
          break
        }
        case "thinking": {
          reasoningAcc += (block as ClaudeThinkingBlock).thinking
          break
        }
        case "tool_use": {
          const tb = block as ClaudeToolUseBlock
          const args =
            typeof tb.input === "string"
              ? tb.input
              : JSON.stringify(tb.input ?? {})
          toolCalls.push({ name: tb.name, args })
          break
        }
        case "tool_result": {
          const tb = block as ClaudeToolResultBlock
          let resultText = ""
          if (typeof tb.content === "string") {
            resultText = tb.content
          } else if (Array.isArray(tb.content)) {
            for (const c of tb.content as ClaudeContentBlock[]) {
              if (c.type === "text") resultText += (c as ClaudeTextBlock).text
            }
          }
          toolResults.push({ text: resultText })
          break
        }
      }
    }

    // Emit the main message (user text or assistant with optional tool calls)
    if (textAcc.trim() || toolCalls.length || reasoningAcc) {
      const m: ExportedMessage = { role }
      if (textAcc.trim()) m.text = textAcc.trim()
      if (reasoningAcc) m.reasoning = reasoningAcc
      if (toolCalls.length) m.toolCalls = toolCalls
      messages.push(m)
    }

    // Emit each tool result as its own role=tool message
    for (const tr of toolResults) {
      messages.push({ role: "tool", text: tr.text })
    }
  }

  return { meta: { source: "claude-code" }, messages }
}

// ── hermes exporter (SQLite) ──────────────────────────────────────────
// node:sqlite is experimental in Node 22.x but functional.
// Isolated here so a future stable import replaces only this function.

interface HermesSessionRow {
  id: string
  title?: string
  model?: string
  started_at?: number
  ended_at?: number
  message_count?: number
  tool_call_count?: number
  api_call_count?: number
  input_tokens?: number
  output_tokens?: number
  cache_read_tokens?: number
  cache_write_tokens?: number
  reasoning_tokens?: number
  actual_cost_usd?: number
  estimated_cost_usd?: number
  source?: string
  end_reason?: string
}

interface HermesMessageRow {
  id: number
  session_id: string
  role: string
  content?: string
  tool_calls?: string
  tool_name?: string
  reasoning?: string
  reasoning_content?: string
  timestamp?: number
}

// Shared by exportHermesSession AND discoverHermesSessions (below) — the
// open + SQLITE_BUSY-retry handling lives in exactly one place so the two
// callers can never drift.
type HermesDb = InstanceType<(typeof import("node:sqlite"))["DatabaseSync"]>

async function openHermesDb(dbPath: string): Promise<HermesDb> {
  // Dynamic import isolates the experimental module warning and lets
  // callers on older Node get a clear error instead of a crash at load time.
  let DatabaseSync: (typeof import("node:sqlite"))["DatabaseSync"]
  try {
    const sqlite = await import("node:sqlite")
    DatabaseSync = sqlite.DatabaseSync
  } catch {
    throw new Error("hermes: node:sqlite unavailable. Requires Node.js ≥22.5.0.")
  }

  try {
    return new DatabaseSync(dbPath, { readOnly: true })
  } catch (err) {
    const msg = String(err)
    if (
      (err as NodeJS.ErrnoException).code === "ENOENT" ||
      msg.includes("unable to open database file")
    ) {
      throw new Error(
        `hermes: state.db not found at ${dbPath}. ` +
          `Has hermes been run at least once?`,
      )
    }
    if (msg.includes("SQLITE_BUSY") || msg.includes("database is locked")) {
      throw new Error(
        `hermes: database is locked (SQLITE_BUSY). ` +
          `Hermes may be writing. Try again in a moment.`,
      )
    }
    throw err
  }
}

function withRetryOnBusy<T>(fn: () => T): T {
  try {
    return fn()
  } catch (err) {
    const msg = String(err)
    if (msg.includes("SQLITE_BUSY") || msg.includes("database is locked")) {
      // One brief retry — the lock is usually transient
      try {
        return fn()
      } catch {
        throw new Error(
          `hermes: database is locked. Hermes may be actively writing. Try again.`,
        )
      }
    }
    throw err
  }
}

/** Generic read-only sqlite open, sharing hermes's node:sqlite plumbing so
 *  the opencode + mastracode-inprocess stores don't each reinvent the
 *  experimental-module guard and the ENOENT/BUSY error mapping. `label` is
 *  the provider name used in the error strings. Returns the same handle
 *  type `withRetryOnBusy` operates on. */
async function openReadonlySqlite(dbPath: string, label: string): Promise<HermesDb> {
  let DatabaseSync: (typeof import("node:sqlite"))["DatabaseSync"]
  try {
    const sqlite = await import("node:sqlite")
    DatabaseSync = sqlite.DatabaseSync
  } catch {
    throw new Error(`${label}: node:sqlite unavailable. Requires Node.js ≥22.5.0.`)
  }
  try {
    return new DatabaseSync(dbPath, { readOnly: true })
  } catch (err) {
    const msg = String(err)
    if (
      (err as NodeJS.ErrnoException).code === "ENOENT" ||
      msg.includes("unable to open database file")
    ) {
      throw new Error(`${label}: database not found at ${dbPath}. Has ${label} been run at least once?`)
    }
    if (msg.includes("SQLITE_BUSY") || msg.includes("database is locked")) {
      throw new Error(`${label}: database is locked (SQLITE_BUSY). It may be writing. Try again in a moment.`)
    }
    throw err
  }
}

export async function exportHermesSession(adapterSessionId: string): Promise<ExportedSession> {
  const dbPath = join(homedir(), ".hermes", "state.db")
  const db = await openHermesDb(dbPath)

  const session = withRetryOnBusy(
    () =>
      db
        .prepare("SELECT * FROM sessions WHERE id = ?")
        .get(adapterSessionId) as unknown as HermesSessionRow | undefined,
  )

  if (!session) {
    db.close()
    throw new Error(
      `hermes: session "${adapterSessionId}" not found in ${dbPath}. ` +
        `ACP sessions are indexed by the agentproto UUID passed as resumeSessionId.`,
    )
  }

  const rows = withRetryOnBusy(
    () =>
      db
        .prepare(
          "SELECT * FROM messages WHERE session_id = ? ORDER BY id ASC",
        )
        .all(adapterSessionId) as unknown as HermesMessageRow[],
  )

  db.close()

  const cost =
    session.actual_cost_usd != null
      ? session.actual_cost_usd
      : session.estimated_cost_usd

  const startedAt = session.started_at
    ? new Date(session.started_at * 1000).toISOString().replace("T", " ").slice(0, 19)
    : undefined
  const endedAt = session.ended_at
    ? new Date(session.ended_at * 1000).toISOString().replace("T", " ").slice(0, 19)
    : undefined

  const meta: ExportedSessionMeta = {
    ...(session.title ? { title: session.title } : {}),
    ...(session.model ? { model: session.model } : {}),
    ...(startedAt ? { startedAt } : {}),
    ...(endedAt ? { endedAt } : {}),
    ...(session.message_count !== undefined ? { messageCount: session.message_count } : {}),
    ...(session.tool_call_count !== undefined
      ? { toolCallCount: session.tool_call_count }
      : {}),
    ...(cost != null ? { costUsd: Number(cost) } : {}),
    ...(session.source ? { source: session.source } : {}),
  }

  // Only include tokens sub-object when at least one field is present
  const tokensInput = session.input_tokens
  const tokensOutput = session.output_tokens
  const tokensCacheRead = session.cache_read_tokens
  const tokensCacheWrite = session.cache_write_tokens
  const tokensReasoning = session.reasoning_tokens
  if (
    tokensInput !== undefined ||
    tokensOutput !== undefined ||
    tokensCacheRead !== undefined ||
    tokensCacheWrite !== undefined ||
    tokensReasoning !== undefined
  ) {
    meta.tokens = {
      ...(tokensInput !== undefined ? { input: tokensInput } : {}),
      ...(tokensOutput !== undefined ? { output: tokensOutput } : {}),
      ...(tokensCacheRead !== undefined ? { cacheRead: tokensCacheRead } : {}),
      ...(tokensCacheWrite !== undefined ? { cacheWrite: tokensCacheWrite } : {}),
      ...(tokensReasoning !== undefined ? { reasoning: tokensReasoning } : {}),
    }
  }

  const messages: ExportedMessage[] = rows.map(row => {
    const validRoles = new Set(["user", "assistant", "tool", "system"])
    const role = (
      validRoles.has(row.role) ? row.role : "user"
    ) as ExportedMessage["role"]

    const reasoning = row.reasoning ?? row.reasoning_content

    let toolCalls: { name: string; args: string }[] | undefined
    if (row.tool_calls) {
      try {
        const tc = JSON.parse(row.tool_calls) as unknown[]
        if (Array.isArray(tc) && tc.length) {
          toolCalls = tc.map(c => {
            const entry = c as Record<string, unknown>
            const fn =
              entry.function != null
                ? (entry.function as Record<string, unknown>)
                : entry
            const name = String(fn.name ?? entry.name ?? "tool")
            const args =
              typeof fn.arguments === "string"
                ? fn.arguments
                : JSON.stringify(fn.arguments ?? {})
            return { name, args }
          })
        }
      } catch {
        // malformed tool_calls — skip
      }
    }

    const m: ExportedMessage = { role }
    if (row.content?.trim()) m.text = row.content.trim()
    if (reasoning && String(reasoning).trim()) m.reasoning = String(reasoning)
    if (row.tool_name) m.toolName = row.tool_name
    if (toolCalls) m.toolCalls = toolCalls
    if (row.timestamp) m.ts = row.timestamp
    return m
  })

  // Fire-and-forget: cross-check our row count against the binary's export.
  // Non-blocking — a mismatch only logs a warning, it never fails the call.
  void crossValidateHermesExport(adapterSessionId, messages.length).catch(() => {})

  return { meta, messages }
}

// ── hermes discovery (SQLite, cwd-scoped) ─────────────────────────────
//
// Reuses openHermesDb/withRetryOnBusy above — the SAME open + BUSY-retry
// path exportHermesSession uses — so there is one sqlite plumbing to
// maintain, not two. Called from conversation-store.ts's hermes `discover`
// via a dynamic import (see that file for why it's dynamic, not static).

function hermesRowToCandidate(row: HermesSessionRow): ConversationCandidate {
  const startedAtIso =
    row.started_at !== undefined ? new Date(row.started_at * 1000).toISOString() : undefined
  // "Last activity" is when the conversation was last written to — ended_at
  // if it has one, else fall back to started_at (a still-open session).
  const lastActivitySec = row.ended_at ?? row.started_at
  const lastActivityIso =
    lastActivitySec !== undefined ? new Date(lastActivitySec * 1000).toISOString() : undefined
  return {
    conversationId: row.id,
    ...(startedAtIso ? { startedAt: startedAtIso } : {}),
    ...(lastActivityIso ? { lastActivityAt: lastActivityIso } : {}),
    ...(row.message_count !== undefined ? { messageCount: row.message_count } : {}),
    ...(row.title ? { preview: row.title } : {}),
    ...(row.source ? { lastWriter: row.source } : {}),
  }
}

export async function discoverHermesSessions(
  cwd: string,
  since?: string,
  expectedId?: string,
): Promise<ConversationCandidate[]> {
  const dbPath = join(homedir(), ".hermes", "state.db")

  let db: HermesDb
  try {
    db = await openHermesDb(dbPath)
  } catch (err) {
    // "state.db not found" == hermes has never run on this box — a normal,
    // empty store, not a discovery error. Anything else (locked, node:sqlite
    // missing) is a genuinely unreadable store and propagates — see the
    // ConversationStore.discover contract in conversation-store.ts.
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.includes("state.db not found")) return []
    throw err
  }

  try {
    // Ground truth beats heuristic: bind to exactly the conversation we
    // were asked about. Binding is by `id`, which is cwd-independent, so
    // this never even looks at `cwd` — never falls through to the cwd-scan
    // below. See the exact-bind invariant in conversation-store.ts.
    if (expectedId) {
      const row = withRetryOnBusy(
        () =>
          db.prepare("SELECT * FROM sessions WHERE id = ?").get(expectedId) as unknown as
            | HermesSessionRow
            | undefined,
      )
      return row ? [hermesRowToCandidate(row)] : []
    }

    const rows = withRetryOnBusy(
      () =>
        db
          .prepare("SELECT * FROM sessions WHERE cwd = ?")
          .all(cwd) as unknown as HermesSessionRow[],
    )
    const sinceMs = since ? Date.parse(since) : NaN
    return rows
      .filter(row => {
        if (!Number.isFinite(sinceMs)) return true
        const lastActivitySec = row.ended_at ?? row.started_at
        if (lastActivitySec === undefined) return true
        return lastActivitySec * 1000 >= sinceMs - 1000
      })
      .map(hermesRowToCandidate)
  } finally {
    db.close()
  }
}

// ── Hermes cross-validation via native CLI ────────────────────────────
//
// `hermes sessions export --session-id <id> -` emits a stable JSONL
// transcript on stdout. We use it as a non-blocking sanity-check:
// if the message count from state.db differs from the binary's output,
// something in the SQLite schema likely changed and the reader needs
// updating. The check is fire-and-forget — a mismatch logs a warning but
// does NOT affect the returned ExportedSession (SQLite stays primary).
//
// The export JSONL has one JSON object per message line; lines with a
// `role` key are treated as messages (other metadata lines are ignored).

export interface HermesCrossValidationResult {
  sqliteCount: number
  binaryCount: number
  matched: boolean
  /** True when the hermes binary was not found on PATH */
  binaryUnavailable?: boolean
}

/** Default subprocess runner: spawns `hermes sessions export --session-id <id> -`
 *  and returns stdout. Throws with `.code="ENOENT"` when the binary isn't on PATH. */
async function defaultHermesRunner(adapterSessionId: string): Promise<string> {
  const { spawn } = await import("node:child_process")
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = []
    const errChunks: Buffer[] = []
    const proc = spawn(
      "hermes",
      ["sessions", "export", "--session-id", adapterSessionId, "-"],
      { stdio: ["ignore", "pipe", "pipe"] },
    )
    proc.stdout.on("data", (chunk: Buffer) => chunks.push(chunk))
    proc.stderr.on("data", (chunk: Buffer) => errChunks.push(chunk))
    proc.on("error", reject)
    proc.on("close", code => {
      if (code !== 0) {
        reject(
          new Error(
            `hermes exited with code ${code}: ${Buffer.concat(errChunks).toString()}`,
          ),
        )
      } else {
        resolve(Buffer.concat(chunks).toString("utf8"))
      }
    })
  })
}

/** Run `hermes sessions export` and compare its message count with
 *  what our SQLite reader produced. Returns null on any subprocess
 *  error (binary missing, timeout, parse failure).
 *
 *  The optional `_runner` parameter lets tests inject a mock that returns stdout
 *  directly, avoiding subprocess mocking complexity (promisify + child_process). */
export async function crossValidateHermesExport(
  adapterSessionId: string,
  sqliteCount: number,
  _runner: (id: string) => Promise<string> = defaultHermesRunner,
): Promise<HermesCrossValidationResult | null> {
  let stdout: string
  try {
    stdout = await _runner(adapterSessionId)
  } catch (err) {
    const msg = String(err)
    // ENOENT = binary not on PATH — expected when hermes isn't installed
    if (
      (err as NodeJS.ErrnoException).code === "ENOENT" ||
      msg.includes("ENOENT") ||
      msg.includes("not found")
    ) {
      return { sqliteCount, binaryCount: -1, matched: true, binaryUnavailable: true }
    }
    // Any other error (timeout, non-zero exit, etc.) — skip validation
    return null
  }

  // Count lines that look like message objects (have a `role` field)
  const binaryCount = stdout
    .split("\n")
    .filter(l => l.trim())
    .filter(l => {
      try {
        const obj = JSON.parse(l) as Record<string, unknown>
        return typeof obj.role === "string"
      } catch {
        return false
      }
    }).length

  const matched = binaryCount === sqliteCount
  if (!matched) {
    console.warn(
      `[hermes export] cross-validation mismatch for session ${adapterSessionId}: ` +
        `SQLite=${sqliteCount} messages, binary=${binaryCount} messages. ` +
        `The state.db schema may have changed — check the SQLite reader in transcript-export.ts.`,
    )
  }
  return { sqliteCount, binaryCount, matched }
}

// ── daemon-events exporter (agentproto's own JSONL capture) ────────────

/** Structural shape of one events.jsonl line — a superset of every
 *  `AgentStreamEvent` kind (see sessions.ts) plus the writer's own
 *  "user-prompt" record. Untyped fields default to undefined rather than
 *  erroring, so a future field this reader doesn't know about is just
 *  ignored instead of breaking the export. */
interface TranscriptRecord {
  seq: number
  ts: string
  kind: string
  text?: string
  partial?: boolean
  toolCallId?: string
  toolName?: string
  arguments?: unknown
  result?: unknown
  isError?: boolean
  reason?: string
  error?: { message: string; code?: number }
  entries?: Array<{ content: string; priority: string; status: string }>
  size?: number
  used?: number
  cost?: { amount: number; currency: string }
}

async function exportDaemonEventsSession(
  sessionId: string,
  desc?: SessionDescriptor,
): Promise<ExportedSession> {
  const filePath = sessionEventsPath(sessionId)

  let stream: ReturnType<typeof createReadStream>
  try {
    stream = createReadStream(filePath, { encoding: "utf8" })
    await new Promise<void>((resolve, reject) => {
      stream.once("error", reject)
      stream.once("open", resolve)
    })
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === "ENOENT") {
      throw new Error(
        `daemon-events: no events.jsonl for session "${sessionId}" (${filePath}).\n` +
          `Either the session never drove an agent-cli turn, or it predates this feature.`,
      )
    }
    throw err
  }

  const messages: ExportedMessage[] = []
  const toolNameById = new Map<string, string>()
  let toolCallCount = 0
  let lastUsage: { size?: number; used?: number; cost?: { amount: number; currency: string } } | undefined

  // One assistant "turn batch" accumulator — text/thought/tool-calls that
  // arrive between two boundary events (a tool-result, a new prompt, a
  // turn-end, ...) collapse into ONE assistant message, mirroring how the
  // claude-code exporter batches a single API-level assistant entry.
  let asmText = ""
  let asmReasoning = ""
  let asmToolCalls: { name: string; args: string }[] = []
  let asmTs: number | undefined

  const flushAssistant = (): void => {
    if (!asmText.trim() && !asmReasoning.trim() && asmToolCalls.length === 0) return
    const m: ExportedMessage = { role: "assistant" }
    if (asmText.trim()) m.text = asmText.trim()
    if (asmReasoning.trim()) m.reasoning = asmReasoning.trim()
    if (asmToolCalls.length) m.toolCalls = asmToolCalls
    if (asmTs !== undefined) m.ts = asmTs
    messages.push(m)
    asmText = ""
    asmReasoning = ""
    asmToolCalls = []
    asmTs = undefined
  }

  const rl = createInterface({ input: stream, crlfDelay: Infinity })
  for await (const line of rl) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let rec: TranscriptRecord
    try {
      rec = JSON.parse(trimmed) as TranscriptRecord
    } catch {
      continue
    }
    const ts = Date.parse(rec.ts)
    const tsOrUndefined = Number.isNaN(ts) ? undefined : ts

    switch (rec.kind) {
      case "user-prompt":
        flushAssistant()
        messages.push({ role: "user", text: rec.text ?? "", ...(tsOrUndefined !== undefined ? { ts: tsOrUndefined } : {}) })
        break
      case "text-delta":
        // Terminated lines already carry their own trailing "\n" (see
        // transcript-writer.ts) — only an unterminated tail fragment
        // (still `partial`, or flushed bare at a turn boundary) lacks one,
        // and that's exactly the byte-for-byte original content.
        if (asmTs === undefined) asmTs = tsOrUndefined
        asmText += rec.text ?? ""
        break
      case "thought":
        if (asmTs === undefined) asmTs = tsOrUndefined
        asmReasoning += rec.text ?? ""
        break
      case "tool-call": {
        if (asmTs === undefined) asmTs = tsOrUndefined
        const name = rec.toolName ?? "tool"
        if (rec.toolCallId) toolNameById.set(rec.toolCallId, name)
        const args =
          typeof rec.arguments === "string" ? rec.arguments : JSON.stringify(rec.arguments ?? {})
        asmToolCalls.push({ name, args })
        toolCallCount += 1
        break
      }
      case "tool-result": {
        flushAssistant()
        const name = rec.toolCallId ? toolNameById.get(rec.toolCallId) : undefined
        const text = typeof rec.result === "string" ? rec.result : JSON.stringify(rec.result ?? "")
        messages.push({
          role: "tool",
          text: rec.isError ? `[error] ${text}` : text,
          ...(name ? { toolName: name } : {}),
          ...(tsOrUndefined !== undefined ? { ts: tsOrUndefined } : {}),
        })
        break
      }
      case "agent-prompt":
        flushAssistant()
        messages.push({ role: "system", text: "[awaiting input] agent requested a decision" })
        break
      case "plan": {
        flushAssistant()
        const entries = rec.entries ?? []
        const done = entries.filter(e => e.status === "completed").length
        const list = entries.map(e => e.content).join("; ")
        messages.push({ role: "system", text: `[plan] ${done}/${entries.length} ${list}`.trim() })
        break
      }
      case "usage_update":
        lastUsage = { size: rec.size, used: rec.used, cost: rec.cost }
        break
      case "error":
        flushAssistant()
        messages.push({ role: "system", text: `[error] ${rec.error?.message ?? "unknown"}` })
        break
      case "turn-end":
        flushAssistant()
        break
      default:
        break
    }
  }
  flushAssistant()

  const meta: ExportedSessionMeta = { source: "daemon-events" }
  if (desc?.label) meta.title = desc.label
  if (desc?.model) meta.model = desc.model
  if (desc?.startedAt) meta.startedAt = desc.startedAt
  if (desc?.endedAt) meta.endedAt = desc.endedAt
  meta.messageCount = messages.length
  meta.toolCallCount = toolCallCount
  if (desc?.costUsd !== undefined) meta.costUsd = desc.costUsd
  else if (lastUsage?.cost) meta.costUsd = lastUsage.cost.amount
  if (desc?.tokensIn !== undefined || desc?.tokensOut !== undefined) {
    meta.tokens = {
      ...(desc?.tokensIn !== undefined ? { input: desc.tokensIn } : {}),
      ...(desc?.tokensOut !== undefined ? { output: desc.tokensOut } : {}),
    }
  }

  return { meta, messages }
}

// ── shared jsonl helper ───────────────────────────────────────────────

/** Read only the first non-empty line of a jsonl file — used by the codex
 *  and pi discovery scans, which only need each file's leading metadata
 *  record (session_meta / session) to answer cwd/id questions without
 *  parsing a possibly-multi-MB transcript. */
async function readFirstJsonLine(path: string): Promise<string | undefined> {
  const stream = createReadStream(path, { encoding: "utf8" })
  const rl = createInterface({ input: stream, crlfDelay: Infinity })
  try {
    for await (const line of rl) {
      const t = line.trim()
      if (t) return t
    }
    return undefined
  } finally {
    rl.close()
    stream.destroy()
  }
}

// ── codex exporter (rollout JSONL) ────────────────────────────────────
//
// Native store: $CODEX_HOME/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl
// (CODEX_HOME defaults to ~/.codex). One append-only JSONL file per
// conversation, written by the Codex core that @zed-industries/codex-acp
// bundles. The first line is a `session_meta` record carrying the
// conversation's `id` (== the trailing uuid in the filename == the ACP
// session id agentproto records as `adapterSessionId` — verified
// empirically against live rollouts) and its `cwd`. Subsequent
// `response_item` lines carry the turns; `event_msg` / `turn_context`
// lines are transport bookkeeping we skip.

function codexHome(): string {
  return process.env.CODEX_HOME ?? join(homedir(), ".codex")
}
function codexSessionsDir(): string {
  return join(codexHome(), "sessions")
}

interface CodexRolloutLine {
  type?: string
  timestamp?: string
  payload?: {
    type?: string
    id?: string
    session_id?: string
    timestamp?: string
    cwd?: string
    model?: string
    model_provider?: string
    role?: string
    content?: Array<{ type?: string; text?: string }>
    summary?: Array<{ type?: string; text?: string }>
    name?: string
    input?: unknown
    arguments?: unknown
    call_id?: string
    output?: unknown
  }
}

/** Recursively collect `rollout-*.jsonl` paths under the YYYY/MM/DD tree. */
async function walkCodexRollouts(dir: string): Promise<string[]> {
  let entries: Dirent[]
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const out: string[] = []
  for (const e of entries) {
    const p = join(dir, e.name)
    if (e.isDirectory()) {
      out.push(...(await walkCodexRollouts(p)))
    } else if (e.isFile() && e.name.startsWith("rollout-") && e.name.endsWith(".jsonl")) {
      out.push(p)
    }
  }
  return out
}

/** Join codex output blocks (input_text / output_text) into one string. */
function codexBlocksText(content: unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  let acc = ""
  for (const c of content) {
    if (c && typeof c === "object") {
      const b = c as { type?: string; text?: string }
      if (typeof b.text === "string" && (b.type === "input_text" || b.type === "output_text" || b.type === "text")) {
        acc += b.text
      }
    }
  }
  return acc
}

async function findCodexRolloutFile(conversationId: string): Promise<string | undefined> {
  const files = await walkCodexRollouts(codexSessionsDir())
  // Fast path: the uuid is the filename suffix.
  const byName = files.find(f => f.endsWith(`-${conversationId}.jsonl`))
  if (byName) return byName
  // Fallback: match on the session_meta id/session_id (covers a future
  // codex build whose filename uuid diverges from the meta id).
  for (const f of files) {
    const first = await readFirstJsonLine(f)
    if (!first) continue
    let meta: CodexRolloutLine
    try {
      meta = JSON.parse(first) as CodexRolloutLine
    } catch {
      continue
    }
    const p = meta.payload
    if (p && (p.id === conversationId || p.session_id === conversationId)) return f
  }
  return undefined
}

export async function exportCodexSession(conversationId: string): Promise<ExportedSession> {
  const file = await findCodexRolloutFile(conversationId)
  if (!file) {
    throw new Error(
      `codex: no rollout file for conversation "${conversationId}" under ${codexSessionsDir()}.\n` +
        `The session may predate persistence, or CODEX_HOME points elsewhere.`,
    )
  }

  const stream = createReadStream(file, { encoding: "utf8" })
  const rl = createInterface({ input: stream, crlfDelay: Infinity })
  const messages: ExportedMessage[] = []
  const toolNameByCall = new Map<string, string>()
  let toolCallCount = 0
  let startedAt: string | undefined
  let model: string | undefined

  for await (const line of rl) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let entry: CodexRolloutLine
    try {
      entry = JSON.parse(trimmed) as CodexRolloutLine
    } catch {
      continue
    }
    const p = entry.payload ?? {}

    if (entry.type === "session_meta") {
      startedAt = p.timestamp ?? entry.timestamp
      if (typeof p.model === "string") model = p.model
      continue
    }
    if (entry.type === "turn_context") {
      if (!model && typeof p.model === "string") model = p.model
      continue
    }
    if (entry.type !== "response_item") continue

    switch (p.type) {
      case "message": {
        const text = codexBlocksText(p.content).trim()
        if (!text) break
        const role: ExportedMessage["role"] =
          p.role === "assistant" ? "assistant" : p.role === "user" ? "user" : "system"
        messages.push({ role, text })
        break
      }
      case "reasoning": {
        // Codex reasoning is usually an opaque `encrypted_content` blob; only
        // an unencrypted `summary` (rare) is human-readable. Emit only when
        // there's real text — never the ciphertext.
        const r = (p.summary ?? []).map(s => s.text ?? "").join("\n").trim()
        if (r) messages.push({ role: "assistant", reasoning: r })
        break
      }
      case "function_call":
      case "custom_tool_call": {
        const name = p.name ?? "tool"
        if (typeof p.call_id === "string") toolNameByCall.set(p.call_id, name)
        const raw = p.type === "custom_tool_call" ? p.input : p.arguments
        const args = typeof raw === "string" ? raw : JSON.stringify(raw ?? {})
        messages.push({ role: "assistant", toolCalls: [{ name, args }] })
        toolCallCount += 1
        break
      }
      case "function_call_output":
      case "custom_tool_call_output": {
        const name = typeof p.call_id === "string" ? toolNameByCall.get(p.call_id) : undefined
        const out = codexBlocksText(p.output) || (typeof p.output === "string" ? p.output : "")
        messages.push({ role: "tool", text: out, ...(name ? { toolName: name } : {}) })
        break
      }
    }
  }

  const meta: ExportedSessionMeta = { source: "codex" }
  if (startedAt) meta.startedAt = startedAt
  if (model) meta.model = model
  meta.messageCount = messages.length
  meta.toolCallCount = toolCallCount
  return { meta, messages }
}

export async function discoverCodexSessions(
  cwd: string,
  since?: string,
  until?: string,
  expectedId?: string,
): Promise<ConversationCandidate[]> {
  const files = await walkCodexRollouts(codexSessionsDir())
  const sinceMs = since ? Date.parse(since) : NaN
  const untilMs = until ? Date.parse(until) : NaN
  const scored: { candidate: ConversationCandidate; mtimeMs: number }[] = []

  for (const f of files) {
    let mtimeMs: number
    try {
      mtimeMs = (await fs.stat(f)).mtimeMs
    } catch {
      continue
    }
    if (Number.isFinite(sinceMs) && mtimeMs < sinceMs - 1000) continue
    const first = await readFirstJsonLine(f)
    if (!first) continue
    let meta: CodexRolloutLine
    try {
      meta = JSON.parse(first) as CodexRolloutLine
    } catch {
      continue
    }
    if (meta.type !== "session_meta") continue
    const p = meta.payload ?? {}
    const id = p.id ?? p.session_id
    if (!id) continue
    // Ground truth beats heuristic: bind to exactly the requested id and
    // ignore cwd (the id is globally unique). See the exact-bind invariant.
    if (expectedId) {
      if (id !== expectedId) continue
    } else if (p.cwd !== cwd) {
      continue
    }
    const startedAt = p.timestamp
    if (Number.isFinite(untilMs) && startedAt) {
      const startedMs = Date.parse(startedAt)
      if (Number.isFinite(startedMs) && startedMs > untilMs) continue
    }
    scored.push({
      candidate: {
        conversationId: id,
        ...(startedAt ? { startedAt } : {}),
        lastActivityAt: new Date(mtimeMs).toISOString(),
      },
      mtimeMs,
    })
  }

  scored.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return scored.map(s => s.candidate)
}

// ── opencode exporter (opencode.db SQLite) ────────────────────────────
//
// Native store: ${XDG_DATA_HOME:-~/.local/share}/opencode/opencode.db — a
// drizzle-managed sqlite with `session` (keyed by the `ses_…` id opencode
// returns over ACP, which agentproto records verbatim as adapterSessionId
// — verified empirically), `message` (JSON `data` per row), and `part`
// (JSON `data`, one row per text/reasoning/tool block). The `session`
// table's `directory` column is the conversation's cwd, enabling
// cwd-scoped discovery.

interface OpenCodeSessionRow {
  id: string
  directory?: string
  title?: string
  model?: string
  cost?: number
  tokens_input?: number
  tokens_output?: number
  tokens_reasoning?: number
  tokens_cache_read?: number
  tokens_cache_write?: number
  time_created?: number
  time_updated?: number
}
interface OpenCodeMessageRow {
  id: string
  data: string
  time_created: number
}
interface OpenCodePartRow {
  message_id: string
  data: string
  time_created: number
}

function openCodeDbPath(): string {
  const dataHome = process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share")
  return join(dataHome, "opencode", "opencode.db")
}

/** `{"id":"gpt-5-mini","providerID":"openai",…}` → `openai/gpt-5-mini`. */
function openCodeModelLabel(raw: string | undefined): string | undefined {
  if (!raw) return undefined
  try {
    const m = JSON.parse(raw) as { id?: string; modelID?: string; providerID?: string }
    const id = m.modelID ?? m.id
    if (!id) return undefined
    return m.providerID ? `${m.providerID}/${id}` : id
  } catch {
    return undefined
  }
}

export async function exportOpenCodeSession(conversationId: string): Promise<ExportedSession> {
  const dbPath = openCodeDbPath()
  const db = await openReadonlySqlite(dbPath, "opencode")
  try {
    const session = withRetryOnBusy(
      () => db.prepare("SELECT * FROM session WHERE id = ?").get(conversationId) as unknown as
        | OpenCodeSessionRow
        | undefined,
    )
    if (!session) {
      throw new Error(
        `opencode: session "${conversationId}" not found in ${dbPath}. ` +
          `Sessions are keyed by the ACP session id (ses_…) recorded as adapterSessionId.`,
      )
    }
    const msgRows = withRetryOnBusy(
      () =>
        db
          .prepare("SELECT id, data, time_created FROM message WHERE session_id = ? ORDER BY time_created ASC, id ASC")
          .all(conversationId) as unknown as OpenCodeMessageRow[],
    )
    const partRows = withRetryOnBusy(
      () =>
        db
          .prepare("SELECT message_id, data, time_created FROM part WHERE session_id = ? ORDER BY time_created ASC, id ASC")
          .all(conversationId) as unknown as OpenCodePartRow[],
    )

    const partsByMsg = new Map<string, OpenCodePartRow[]>()
    for (const r of partRows) {
      const list = partsByMsg.get(r.message_id) ?? []
      list.push(r)
      partsByMsg.set(r.message_id, list)
    }

    const messages: ExportedMessage[] = []
    let toolCallCount = 0
    for (const m of msgRows) {
      let mdata: { role?: string }
      try {
        mdata = JSON.parse(m.data) as { role?: string }
      } catch {
        continue
      }
      const role: ExportedMessage["role"] = mdata.role === "assistant" ? "assistant" : "user"
      let text = ""
      let reasoning = ""
      const toolCalls: { name: string; args: string }[] = []
      const toolResults: { name?: string; text: string }[] = []
      for (const pr of partsByMsg.get(m.id) ?? []) {
        let part: {
          type?: string
          text?: string
          tool?: string
          state?: { input?: unknown; output?: unknown }
        }
        try {
          part = JSON.parse(pr.data) as typeof part
        } catch {
          continue
        }
        switch (part.type) {
          case "text":
            if (part.text) text += part.text
            break
          case "reasoning":
            if (part.text) reasoning += part.text
            break
          case "tool": {
            const name = part.tool ?? "tool"
            toolCalls.push({ name, args: JSON.stringify(part.state?.input ?? {}) })
            toolCallCount += 1
            const output = part.state?.output
            if (output !== undefined && output !== null && output !== "") {
              toolResults.push({ name, text: typeof output === "string" ? output : JSON.stringify(output) })
            }
            break
          }
          // step-start / step-finish / patch / snapshot / file — skip.
        }
      }
      if (text.trim() || reasoning.trim() || toolCalls.length) {
        const em: ExportedMessage = { role }
        if (text.trim()) em.text = text.trim()
        if (reasoning.trim()) em.reasoning = reasoning.trim()
        if (toolCalls.length) em.toolCalls = toolCalls
        em.ts = m.time_created
        messages.push(em)
      }
      for (const tr of toolResults) {
        messages.push({ role: "tool", text: tr.text, ...(tr.name ? { toolName: tr.name } : {}) })
      }
    }

    const meta: ExportedSessionMeta = { source: "opencode" }
    if (session.title) meta.title = session.title
    const model = openCodeModelLabel(session.model)
    if (model) meta.model = model
    if (session.time_created) meta.startedAt = new Date(session.time_created).toISOString()
    if (session.time_updated) meta.endedAt = new Date(session.time_updated).toISOString()
    meta.messageCount = messages.length
    meta.toolCallCount = toolCallCount
    if (session.cost != null) meta.costUsd = Number(session.cost)
    const tk = {
      ...(session.tokens_input != null ? { input: session.tokens_input } : {}),
      ...(session.tokens_output != null ? { output: session.tokens_output } : {}),
      ...(session.tokens_cache_read != null ? { cacheRead: session.tokens_cache_read } : {}),
      ...(session.tokens_cache_write != null ? { cacheWrite: session.tokens_cache_write } : {}),
      ...(session.tokens_reasoning != null ? { reasoning: session.tokens_reasoning } : {}),
    }
    if (Object.keys(tk).length) meta.tokens = tk
    return { meta, messages }
  } finally {
    db.close()
  }
}

export async function discoverOpenCodeSessions(
  cwd: string,
  since?: string,
  expectedId?: string,
): Promise<ConversationCandidate[]> {
  const dbPath = openCodeDbPath()
  let db: HermesDb
  try {
    db = await openReadonlySqlite(dbPath, "opencode")
  } catch (err) {
    // A missing db == opencode never ran here — a normal empty store, not a
    // discovery error (mirrors discoverHermesSessions).
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.includes("database not found")) return []
    throw err
  }
  try {
    if (expectedId) {
      const row = withRetryOnBusy(
        () => db.prepare("SELECT * FROM session WHERE id = ?").get(expectedId) as unknown as
          | OpenCodeSessionRow
          | undefined,
      )
      return row ? [openCodeRowToCandidate(row)] : []
    }
    const rows = withRetryOnBusy(
      () => db.prepare("SELECT * FROM session WHERE directory = ?").all(cwd) as unknown as OpenCodeSessionRow[],
    )
    const sinceMs = since ? Date.parse(since) : NaN
    return rows
      .filter(r => {
        if (!Number.isFinite(sinceMs)) return true
        const last = r.time_updated ?? r.time_created
        return last === undefined || last >= sinceMs - 1000
      })
      .map(openCodeRowToCandidate)
  } finally {
    db.close()
  }
}

function openCodeRowToCandidate(row: OpenCodeSessionRow): ConversationCandidate {
  return {
    conversationId: row.id,
    ...(row.time_created ? { startedAt: new Date(row.time_created).toISOString() } : {}),
    ...(row.time_updated ? { lastActivityAt: new Date(row.time_updated).toISOString() } : {}),
    ...(row.title ? { preview: row.title } : {}),
  }
}

// ── mastracode-inprocess exporter (Mastra libsql) ─────────────────────
//
// Native store: ${AGENTPROTO_HOME:-~/.agentproto}/mastracode-inprocess/
// storage.db — the dedicated Mastra libsql db the in-process arm writes
// (adapters/mastracode-inprocess/src/client.ts). The arm's public
// sessionId is the composite "<resourceId>:<threadId>"; agentproto records
// it verbatim as adapterSessionId. Threads live in `mastra_threads` (keyed
// by threadId) and messages in `mastra_messages` (keyed by `thread_id`,
// each `content` a Mastra v2 `{format,parts}` JSON). The store has no cwd
// column, so cwd-scoped discovery is not possible — but this in-process arm
// always yields an adapterSessionId, so the exact-bind path is the only one
// that ever runs in practice.

interface MastraThreadRow {
  id: string
  resourceId?: string
  title?: string
  createdAt?: string
  updatedAt?: string
}
interface MastraMessageRow {
  role: string
  content: string
  createdAt: string
}

function mastracodeInprocessDbPath(): string {
  const home = process.env.AGENTPROTO_HOME ?? join(homedir(), ".agentproto")
  return join(home, "mastracode-inprocess", "storage.db")
}

/** Split "<resourceId>:<threadId>"; tolerate a bare threadId (no colon). */
function mastraThreadId(conversationId: string): string {
  const idx = conversationId.indexOf(":")
  return idx > 0 ? conversationId.slice(idx + 1) : conversationId
}

/** Pull user/assistant text, reasoning, and tool calls/results out of one
 *  Mastra v2 `{format,parts}` content blob. */
function mastraContentToMessage(
  role: ExportedMessage["role"],
  content: string,
): { message?: ExportedMessage; toolResults: { name?: string; text: string }[]; toolCalls: number } {
  const toolResults: { name?: string; text: string }[] = []
  let parsed: { parts?: unknown[] }
  try {
    parsed = JSON.parse(content) as { parts?: unknown[] }
  } catch {
    return { message: undefined, toolResults, toolCalls: 0 }
  }
  let text = ""
  let reasoning = ""
  const toolCalls: { name: string; args: string }[] = []
  for (const raw of parsed.parts ?? []) {
    if (!raw || typeof raw !== "object") continue
    const part = raw as {
      type?: string
      text?: string
      reasoning?: string
      toolInvocation?: { toolName?: string; args?: unknown; result?: unknown }
    }
    if (part.type === "text" && part.text) text += part.text
    else if (part.type === "reasoning" && part.reasoning) reasoning += part.reasoning
    else if (part.type === "tool-invocation" && part.toolInvocation) {
      const inv = part.toolInvocation
      const name = inv.toolName ?? "tool"
      toolCalls.push({ name, args: JSON.stringify(inv.args ?? {}) })
      if (inv.result !== undefined) {
        const r = inv.result as { content?: Array<{ type?: string; text?: string }> }
        const rtext = Array.isArray(r?.content)
          ? r.content.filter(c => c?.type === "text").map(c => c.text ?? "").join("")
          : typeof inv.result === "string"
            ? inv.result
            : JSON.stringify(inv.result)
        toolResults.push({ name, text: rtext })
      }
    }
    // data-* and step-start parts are internal bookkeeping — skip.
  }
  let message: ExportedMessage | undefined
  if (text.trim() || reasoning.trim() || toolCalls.length) {
    message = { role }
    if (text.trim()) message.text = text.trim()
    if (reasoning.trim()) message.reasoning = reasoning.trim()
    if (toolCalls.length) message.toolCalls = toolCalls
  }
  return { message, toolResults, toolCalls: toolCalls.length }
}

export async function exportMastracodeInprocessSession(conversationId: string): Promise<ExportedSession> {
  const threadId = mastraThreadId(conversationId)
  const dbPath = mastracodeInprocessDbPath()
  const db = await openReadonlySqlite(dbPath, "mastracode-inprocess")
  try {
    const thread = withRetryOnBusy(
      () => db.prepare("SELECT * FROM mastra_threads WHERE id = ?").get(threadId) as unknown as
        | MastraThreadRow
        | undefined,
    )
    if (!thread) {
      throw new Error(
        `mastracode-inprocess: thread "${threadId}" not found in ${dbPath}. ` +
          `The sessionId is "<resourceId>:<threadId>"; only the threadId is looked up.`,
      )
    }
    const rows = withRetryOnBusy(
      () =>
        db
          .prepare('SELECT role, content, createdAt FROM mastra_messages WHERE thread_id = ? ORDER BY "createdAt" ASC')
          .all(threadId) as unknown as MastraMessageRow[],
    )
    const messages: ExportedMessage[] = []
    let toolCallCount = 0
    for (const r of rows) {
      // Mastra tags user turns with role "signal"; assistant with "assistant".
      const role: ExportedMessage["role"] = r.role === "assistant" ? "assistant" : "user"
      const { message, toolResults, toolCalls } = mastraContentToMessage(role, r.content)
      if (message) messages.push(message)
      toolCallCount += toolCalls
      for (const tr of toolResults) {
        messages.push({ role: "tool", text: tr.text, ...(tr.name ? { toolName: tr.name } : {}) })
      }
    }
    const meta: ExportedSessionMeta = { source: "mastracode-inprocess" }
    if (thread.title) meta.title = thread.title
    if (thread.createdAt) meta.startedAt = thread.createdAt
    if (thread.updatedAt) meta.endedAt = thread.updatedAt
    meta.messageCount = messages.length
    meta.toolCallCount = toolCallCount
    return { meta, messages }
  } finally {
    db.close()
  }
}

export async function discoverMastracodeInprocessSessions(
  _cwd: string,
  since?: string,
  expectedId?: string,
): Promise<ConversationCandidate[]> {
  const dbPath = mastracodeInprocessDbPath()
  let db: HermesDb
  try {
    db = await openReadonlySqlite(dbPath, "mastracode-inprocess")
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.includes("database not found")) return []
    throw err
  }
  try {
    // Exact-bind only: `mastra_threads` has no cwd column, so a cwd-scoped
    // scan is impossible. Absent an expectedId there is nothing to safely
    // scope to, so return none (this in-process arm always supplies an
    // adapterSessionId, so the exact-bind path is the real one).
    if (!expectedId) return []
    const threadId = mastraThreadId(expectedId)
    const thread = withRetryOnBusy(
      () => db.prepare("SELECT * FROM mastra_threads WHERE id = ?").get(threadId) as unknown as
        | MastraThreadRow
        | undefined,
    )
    if (!thread) return []
    const sinceMs = since ? Date.parse(since) : NaN
    if (Number.isFinite(sinceMs) && thread.updatedAt) {
      const upd = Date.parse(thread.updatedAt)
      if (Number.isFinite(upd) && upd < sinceMs - 1000) return []
    }
    return [
      {
        // Echo back the full composite id so callers/read() round-trip it.
        conversationId: expectedId,
        ...(thread.createdAt ? { startedAt: thread.createdAt } : {}),
        ...(thread.updatedAt ? { lastActivityAt: thread.updatedAt } : {}),
        ...(thread.title ? { preview: thread.title } : {}),
      },
    ]
  } finally {
    db.close()
  }
}

// ── pi exporter (JSON-over-stdio session log) ─────────────────────────
//
// Native store: ~/.pi/agent/sessions/<cwd-slug>/<ts>_<uuid>.jsonl — pi
// writes one append-only JSONL per conversation. The first line is a
// `session` record carrying the uuid `id` (== pi's RPC `sessionId`, which
// agentproto records as adapterSessionId — pi's client captures it from
// get_state) and the `cwd`. `message` lines carry the turns; the
// cwd-slug directory encoding is version-dependent, so discovery scans and
// keys off each file's authoritative `session.cwd` rather than the slug.

function piSessionsDir(): string {
  return join(homedir(), ".pi", "agent", "sessions")
}

interface PiLine {
  type?: string
  id?: string
  cwd?: string
  timestamp?: string
  provider?: string
  modelId?: string
  message?: {
    role?: string
    toolName?: string
    isError?: boolean
    content?: unknown
  }
}

/** Text of pi content blocks (`{type:"text",text}`), string-tolerant. */
function piBlocksText(content: unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  let acc = ""
  for (const c of content) {
    if (c && typeof c === "object") {
      const b = c as { type?: string; text?: string }
      if (b.type === "text" && typeof b.text === "string") acc += b.text
    }
  }
  return acc
}

async function walkPiSessionFiles(dir: string): Promise<string[]> {
  let entries: Dirent[]
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const out: string[] = []
  for (const e of entries) {
    const p = join(dir, e.name)
    if (e.isDirectory()) out.push(...(await walkPiSessionFiles(p)))
    else if (e.isFile() && e.name.endsWith(".jsonl")) out.push(p)
  }
  return out
}

async function findPiSessionFile(conversationId: string): Promise<string | undefined> {
  const files = await walkPiSessionFiles(piSessionsDir())
  const byName = files.find(f => f.endsWith(`_${conversationId}.jsonl`))
  if (byName) return byName
  for (const f of files) {
    const first = await readFirstJsonLine(f)
    if (!first) continue
    try {
      const meta = JSON.parse(first) as PiLine
      if (meta.type === "session" && meta.id === conversationId) return f
    } catch {
      // skip
    }
  }
  return undefined
}

export async function exportPiSession(conversationId: string): Promise<ExportedSession> {
  const file = await findPiSessionFile(conversationId)
  if (!file) {
    throw new Error(
      `pi: no session file for conversation "${conversationId}" under ${piSessionsDir()}.`,
    )
  }
  const stream = createReadStream(file, { encoding: "utf8" })
  const rl = createInterface({ input: stream, crlfDelay: Infinity })
  const messages: ExportedMessage[] = []
  let toolCallCount = 0
  let startedAt: string | undefined
  let model: string | undefined

  for await (const line of rl) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let entry: PiLine
    try {
      entry = JSON.parse(trimmed) as PiLine
    } catch {
      continue
    }
    if (entry.type === "session") {
      startedAt = entry.timestamp
      continue
    }
    if (entry.type === "model_change") {
      model = entry.provider ? `${entry.provider}/${entry.modelId ?? ""}` : entry.modelId
      continue
    }
    if (entry.type !== "message" || !entry.message) continue
    const m = entry.message
    const content = m.content

    if (m.role === "toolResult") {
      const text = piBlocksText(content)
      messages.push({
        role: "tool",
        text: m.isError ? `[error] ${text}` : text,
        ...(m.toolName ? { toolName: m.toolName } : {}),
      })
      continue
    }

    const role: ExportedMessage["role"] = m.role === "assistant" ? "assistant" : "user"
    let text = ""
    let reasoning = ""
    const toolCalls: { name: string; args: string }[] = []
    if (typeof content === "string") {
      text = content
    } else if (Array.isArray(content)) {
      for (const raw of content) {
        if (!raw || typeof raw !== "object") continue
        const part = raw as {
          type?: string
          text?: string
          thinking?: string
          name?: string
          arguments?: unknown
        }
        if (part.type === "text" && part.text) text += part.text
        else if (part.type === "thinking" && part.thinking) reasoning += part.thinking
        else if (part.type === "toolCall") {
          toolCalls.push({ name: part.name ?? "tool", args: JSON.stringify(part.arguments ?? {}) })
          toolCallCount += 1
        }
      }
    }
    if (text.trim() || reasoning.trim() || toolCalls.length) {
      const em: ExportedMessage = { role }
      if (text.trim()) em.text = text.trim()
      if (reasoning.trim()) em.reasoning = reasoning.trim()
      if (toolCalls.length) em.toolCalls = toolCalls
      messages.push(em)
    }
  }

  const meta: ExportedSessionMeta = { source: "pi" }
  if (startedAt) meta.startedAt = startedAt
  if (model) meta.model = model
  meta.messageCount = messages.length
  meta.toolCallCount = toolCallCount
  return { meta, messages }
}

export async function discoverPiSessions(
  cwd: string,
  since?: string,
  until?: string,
  expectedId?: string,
): Promise<ConversationCandidate[]> {
  const files = await walkPiSessionFiles(piSessionsDir())
  const sinceMs = since ? Date.parse(since) : NaN
  const untilMs = until ? Date.parse(until) : NaN
  const scored: { candidate: ConversationCandidate; mtimeMs: number }[] = []

  for (const f of files) {
    let mtimeMs: number
    try {
      mtimeMs = (await fs.stat(f)).mtimeMs
    } catch {
      continue
    }
    if (Number.isFinite(sinceMs) && mtimeMs < sinceMs - 1000) continue
    const first = await readFirstJsonLine(f)
    if (!first) continue
    let meta: PiLine
    try {
      meta = JSON.parse(first) as PiLine
    } catch {
      continue
    }
    if (meta.type !== "session" || !meta.id) continue
    if (expectedId) {
      if (meta.id !== expectedId) continue
    } else if (meta.cwd !== cwd) {
      continue
    }
    const startedAt = meta.timestamp
    if (Number.isFinite(untilMs) && startedAt) {
      const s = Date.parse(startedAt)
      if (Number.isFinite(s) && s > untilMs) continue
    }
    scored.push({
      candidate: {
        conversationId: meta.id,
        ...(startedAt ? { startedAt } : {}),
        lastActivityAt: new Date(mtimeMs).toISOString(),
      },
      mtimeMs,
    })
  }

  scored.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return scored.map(s => s.candidate)
}

// ── Strategy registry ─────────────────────────────────────────────────

const EXPORT_STRATEGIES: Record<string, ExportStrategy> = {
  "claude-code": {
    exportSession: exportClaudeCodeSession,
  },
  hermes: {
    exportSession: (id: string) => exportHermesSession(id),
  },
  codex: {
    exportSession: (id: string) => exportCodexSession(id),
  },
  opencode: {
    exportSession: (id: string) => exportOpenCodeSession(id),
  },
  "mastracode-inprocess": {
    exportSession: (id: string) => exportMastracodeInprocessSession(id),
  },
  pi: {
    exportSession: (id: string) => exportPiSession(id),
  },
}

// ── Public API ────────────────────────────────────────────────────────

export type ExportSource = "auto" | "native" | "daemon"

export interface ExportAgentSessionInput {
  /** agentproto session id (sess_xxx) or an adapter-native id */
  sessionId: string
  registry: SessionsRegistry
  format?: "markdown" | "json"
  maxToolChars?: number
  /** Override adapter slug when sessionId is an adapter-native id */
  adapter?: string
  /** Override cwd when sessionId is an adapter-native id (claude-code only) */
  cwd?: string
  /** Which backend to read from. "auto" (default) prefers the adapter's
   *  own native store and falls back to agentproto's own events.jsonl
   *  capture when there isn't one (or it can't be read); "native" / "daemon"
   *  force one and surface its own error instead of falling back. */
  source?: ExportSource
}

export interface ExportAgentSessionResult {
  sessionId: string
  adapter: string
  format: string
  meta: ExportedSessionMeta
  content: string
}

export async function exportAgentSession(
  input: ExportAgentSessionInput,
): Promise<ExportAgentSessionResult> {
  const { sessionId, registry, format = "markdown", maxToolChars = 1200 } = input
  const source = input.source ?? "auto"

  // Resolve via registry first. `err` closes over `adapterSlug` so it
  // returns the resolved slug (not the raw input) after registry lookup.
  let adapterSlug = input.adapter
  let cwd = input.cwd
  let adapterSessionId = sessionId

  const err = (msg: string): ExportAgentSessionResult => ({
    sessionId,
    adapter: adapterSlug ?? "unknown",
    format,
    meta: {},
    content: `Error: ${msg}`,
  })

  const desc = registry.findByIdOrName(sessionId)
  // events.jsonl is always keyed by the agentproto session id — never the
  // adapter-native id substituted below for the native strategies.
  const daemonSessionId = desc?.id ?? sessionId
  if (desc) {
    adapterSlug = adapterSlug ?? desc.adapterSlug
    cwd = cwd ?? desc.cwd
    // prefer the adapter-native id over the agentproto id
    if (desc.adapterSessionId) adapterSessionId = desc.adapterSessionId
  }

  const tryNative = async (): Promise<ExportedSession> => {
    if (!adapterSlug) {
      throw new Error(
        `session "${sessionId}" not found in registry and no adapter override supplied.\n` +
          `Pass adapter explicitly or use a known session id (sess_xxx or name).`,
      )
    }
    const exporter = EXPORT_STRATEGIES[adapterSlug]
    if (!exporter) {
      const supported = Object.keys(EXPORT_STRATEGIES).join(", ")
      throw new Error(
        `no exporter for adapter "${adapterSlug}". Supported: ${supported}.\n` +
          `Only sessions spawned via claude-code or hermes can be exported.`,
      )
    }
    return exporter.exportSession(adapterSessionId, cwd)
  }

  const tryDaemon = (): Promise<ExportedSession> => exportDaemonEventsSession(daemonSessionId, desc)

  let session: ExportedSession
  try {
    if (source === "native") {
      session = await tryNative()
    } else if (source === "daemon") {
      session = await tryDaemon()
    } else {
      try {
        session = await tryNative()
      } catch (nativeErr) {
        try {
          session = await tryDaemon()
        } catch (daemonErr) {
          const nativeMsg = nativeErr instanceof Error ? nativeErr.message : String(nativeErr)
          const daemonMsg = daemonErr instanceof Error ? daemonErr.message : String(daemonErr)
          return err(`${nativeMsg}\n(daemon-events fallback also failed: ${daemonMsg})`)
        }
      }
    }
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e))
  }

  const content =
    format === "json"
      ? renderJson(session)
      : renderMarkdown(session, { maxToolChars })

  return {
    sessionId,
    adapter: adapterSlug ?? (session.meta.source === "daemon-events" ? "daemon" : "unknown"),
    format,
    meta: session.meta,
    content,
  }
}
