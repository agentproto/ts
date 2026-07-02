/**
 * Export a clean, readable transcript from the source an adapter already
 * persists — instead of parsing the noisy ANSI/ACP ring buffer.
 *
 * Two backends, dispatched by adapter slug:
 *   claude-code — reads ~/.claude/projects/<cwd-encoded>/<sessionId>.jsonl
 *   hermes      — reads ~/.hermes/state.db via node:sqlite (read-only)
 *
 * Output: Markdown (default) or JSON, built from a shared ExportedSession
 * model so both adapters produce identical rendering logic.
 */

import { createReadStream } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { createInterface } from "node:readline"
import type { SessionsRegistry } from "./sessions.js"
import { formatToolCall } from "./tool-presenter.js"

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

async function exportClaudeCodeSession(
  adapterSessionId: string,
  cwd?: string,
): Promise<ExportedSession> {
  if (!cwd) {
    throw new Error(
      "claude-code exporter: cwd is required to locate the JSONL file.\n" +
        "Pass cwd explicitly or use a session id that is in the registry.",
    )
  }
  const encoded = cwd.replace(/\//g, "-")
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

async function exportHermesSession(adapterSessionId: string): Promise<ExportedSession> {
  const dbPath = join(homedir(), ".hermes", "state.db")

  // Dynamic import isolates the experimental module warning and lets
  // callers on older Node get a clear error instead of a crash at load time.
  let DatabaseSync: (typeof import("node:sqlite"))["DatabaseSync"]
  try {
    const sqlite = await import("node:sqlite")
    DatabaseSync = sqlite.DatabaseSync
  } catch {
    throw new Error(
      "hermes exporter: node:sqlite unavailable. Requires Node.js ≥22.5.0.",
    )
  }

  let db: InstanceType<typeof DatabaseSync>
  try {
    db = new DatabaseSync(dbPath, { readOnly: true })
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

  const withRetryOnBusy = <T>(fn: () => T): T => {
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

// ── Strategy registry ─────────────────────────────────────────────────

const EXPORT_STRATEGIES: Record<string, ExportStrategy> = {
  "claude-code": {
    exportSession: exportClaudeCodeSession,
  },
  hermes: {
    exportSession: (id: string) => exportHermesSession(id),
  },
}

// ── Public API ────────────────────────────────────────────────────────

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
  if (desc) {
    adapterSlug = adapterSlug ?? desc.adapterSlug
    cwd = cwd ?? desc.cwd
    // prefer the adapter-native id over the agentproto id
    if (desc.adapterSessionId) adapterSessionId = desc.adapterSessionId
  }

  if (!adapterSlug) {
    return err(
      `session "${sessionId}" not found in registry and no adapter override supplied.\n` +
        `Pass adapter explicitly or use a known session id (sess_xxx or name).`,
    )
  }

  const exporter = EXPORT_STRATEGIES[adapterSlug]
  if (!exporter) {
    const supported = Object.keys(EXPORT_STRATEGIES).join(", ")
    return err(
      `no exporter for adapter "${adapterSlug}". Supported: ${supported}.\n` +
        `Only sessions spawned via claude-code or hermes can be exported.`,
    )
  }

  let session: ExportedSession
  try {
    session = await exporter.exportSession(adapterSessionId, cwd)
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e))
  }

  const content =
    format === "json"
      ? renderJson(session)
      : renderMarkdown(session, { maxToolChars })

  return {
    sessionId,
    adapter: adapterSlug,
    format,
    meta: session.meta,
    content,
  }
}
