/**
 * outbound-adapters — provider-agnostic send for outbound messages.
 * Symmetric to inbound-adapters.ts on the read side.
 *
 * Supports the dialects documented in packages/runtime/docs/TRANSMITTER.md.
 */

import { readFile } from "node:fs/promises"
import { basename, extname } from "node:path"

import type { McpProxyRegistry } from "./mcp-proxy.js"
import type { TelegramBotCredsStore } from "./telegram-bot-creds.js"

export type OutboundProvider =
  | "agentpush"
  | "telegram"
  | "whatsapp"
  | "slack"
  | "generic"
  | "native"

export const OUTBOUND_PROVIDERS: readonly OutboundProvider[] = [
  "agentpush",
  "telegram",
  "whatsapp",
  "slack",
  "generic",
  "native",
]

export type { TelegramBotCredsStore }

export interface OutboundAttachment {
  type: "photo" | "document" | "video" | "audio"
  path: string
  caption?: string
}

export interface SendOutboundInput {
  alias?: string
  source: string
  contactRef: string
  text: string
  attachments?: OutboundAttachment[]
}

export interface SendOutboundDeps {
  mcpProxy: McpProxyRegistry
  telegramCreds?: TelegramBotCredsStore
}

export type SendOutboundResult =
  | { ok: true; providerMessageId?: string }
  | { ok: false; error: string; blockedReason?: string; suggestion?: string }

export async function sendOutbound(
  provider: OutboundProvider,
  input: SendOutboundInput,
  deps: SendOutboundDeps,
): Promise<SendOutboundResult> {
  switch (provider) {
    case "agentpush":
      return sendAgentpush(input, deps)
    case "telegram":
      return sendTelegram(input, deps)
    case "whatsapp":
    case "slack":
    case "generic":
    case "native":
      return { ok: false, error: "unsupported_provider" }
    default:
      // Exhaustiveness guard — provider is typed, but keep TS happy.
      return { ok: false, error: "unsupported_provider" }
  }
}

// ── agentpush ───────────────────────────────────────────────────────────

type AgentpushMediaType = "image" | "video" | "audio" | "document"

/**
 * Unwrap an MCP `tools/call` result into its payload object. agentpush tools
 * return structured JSON (`structuredContent`, or a JSON-serialized text
 * content block) rather than a flat object — reading fields straight off the
 * `CallToolResult` envelope silently finds nothing. Falls back to treating
 * the input as an already-flat payload for callers/tests that pass one directly.
 */
function unwrapMcpToolResult(result: unknown): Record<string, unknown> {
  if (!result || typeof result !== "object") return {}
  const envelope = result as {
    structuredContent?: unknown
    content?: Array<{ type?: string; text?: string }>
  }
  if (envelope.structuredContent && typeof envelope.structuredContent === "object") {
    return envelope.structuredContent as Record<string, unknown>
  }
  const text = envelope.content?.find(c => c.type === "text")?.text
  if (typeof text === "string") {
    try {
      const parsed = JSON.parse(text) as unknown
      if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>
    } catch {
      // Not JSON — fall through to the flat-payload treatment below.
    }
  }
  return result as Record<string, unknown>
}

async function sendAgentpush(
  input: SendOutboundInput,
  deps: SendOutboundDeps,
): Promise<SendOutboundResult> {
  const alias = input.alias
  if (!alias) {
    return { ok: false, error: "missing_alias" }
  }

  let media: unknown[] | undefined
  if (input.attachments && input.attachments.length > 0) {
    const uploaded: unknown[] = []
    for (const att of input.attachments) {
      let buffer: Buffer
      try {
        buffer = Buffer.from(await readFile(att.path))
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return { ok: false, error: `failed_to_read_attachment_${att.path}: ${message}` }
      }

      const filename = basename(att.path)
      const mimeType = mimeTypeFor(extname(att.path), att.type)
      const type = mapOutboundTypeToAgentpushType(att.type)

      const upload = await deps.mcpProxy.callTool(alias, "upload_media", {
        channel: input.source,
        type,
        data: buffer.toString("base64"),
        filename,
        mimeType,
      })

      if (!upload.ok) {
        return { ok: false, error: `upload_media_failed: ${upload.error}` }
      }

      const result = unwrapMcpToolResult(upload.result)
      const providerMediaId =
        typeof result.media_id === "string"
          ? result.media_id
          : typeof result.id === "string"
            ? result.id
            : undefined
      if (!providerMediaId) {
        return { ok: false, error: "upload_media_missing_media_id" }
      }

      const item: Record<string, unknown> = {
        type,
        providerMediaId,
        filename,
        mimeType,
      }
      if (att.caption) item.caption = att.caption
      uploaded.push(item)
    }
    media = uploaded
  }

  const content: Record<string, unknown> = { text: input.text }
  if (media) content.media = media

  const out = await deps.mcpProxy.callTool(alias, "send_message", {
    to: { channel: input.source, address: input.contactRef },
    content,
  })

  if (!out.ok) {
    return { ok: false, error: out.error }
  }

  // agentpush's house convention: a tool never throws for a send it can't
  // make — it replies HTTP 200 with `status: "blocked"` (opt-out, expired
  // session, unapproved template…) or `status: "failed"`. Reading only the
  // MCP transport's own success (`out.ok`) — as this used to — reports
  // `sent: true` on a message that never left. Read the payload's own
  // status instead of trusting transport-level success.
  const payload = unwrapMcpToolResult(out.result)
  const status = typeof payload.status === "string" ? payload.status : undefined

  if (status === "blocked") {
    const blockedReason =
      typeof payload.blocked_reason === "string" ? payload.blocked_reason : "blocked"
    const suggestion = typeof payload.suggestion === "string" ? payload.suggestion : undefined
    return { ok: false, error: blockedReason, blockedReason, ...(suggestion ? { suggestion } : {}) }
  }
  if (status === "failed") {
    const error = typeof payload.error === "string" ? payload.error : "failed"
    return { ok: false, error }
  }

  // status is "sent" | "queued" (or an unrecognized/legacy shape) — treat as
  // a real send and surface the provider's own message id so `check_delivery`
  // (which requires `message_id` or `broadcast_id`) can be used afterwards.
  const providerMessageId = extractProviderMessageId(payload)
  return { ok: true, providerMessageId }
}

// ── telegram ────────────────────────────────────────────────────────────

async function sendTelegram(
  input: SendOutboundInput,
  deps: SendOutboundDeps,
): Promise<SendOutboundResult> {
  const alias = input.alias ?? "default"
  const creds = deps.telegramCreds
  if (!creds) {
    return { ok: false, error: "telegram_creds_not_configured" }
  }

  const tokenRecord = await creds.read(alias)
  if (!tokenRecord) {
    return { ok: false, error: `telegram_token_not_found_for_alias_${alias}` }
  }

  const chatId = input.contactRef

  if (!input.attachments || input.attachments.length === 0) {
    const url = `https://api.telegram.org/bot${tokenRecord.token}/sendMessage`
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: convertMarkdownToTelegram(input.text),
        parse_mode: "MarkdownV2",
      }),
    })

    return parseTelegramSendResponse(res)
  }

  // Media path: read files and build multipart/form-data.
  const files: MultipartFile[] = []
  for (const att of input.attachments) {
    let data: Buffer
    try {
      data = Buffer.from(await readFile(att.path))
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { ok: false, error: `failed_to_read_attachment_${att.path}: ${message}` }
    }
    files.push({
      name: att.type,
      filename: basename(att.path),
      contentType: mimeTypeFor(extname(att.path), att.type),
      data,
    })
  }

  if (input.attachments.length === 1) {
    const att = input.attachments[0]!
    const method = telegramMethodForType(att.type)
    const url = `https://api.telegram.org/bot${tokenRecord.token}/${method}`

    const fields: MultipartField[] = [{ name: "chat_id", value: chatId }]
    const caption = att.caption || input.text
    if (caption) {
      fields.push({ name: "caption", value: convertMarkdownToTelegram(caption) })
      fields.push({ name: "parse_mode", value: "MarkdownV2" })
    }

    const { body, contentType } = buildMultipartBody(fields, files)
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": contentType },
      body: toFetchBody(body),
    })

    return parseTelegramSendResponse(res)
  }

  const mediaJson = input.attachments.map((att, index) => {
    const item: Record<string, unknown> = {
      type: telegramMediaTypeFor(att.type),
      media: `attach://file${index}`,
    }
    if (index === 0) {
      const caption = att.caption || input.text
      if (caption) {
        item.caption = convertMarkdownToTelegram(caption)
        item.parse_mode = "MarkdownV2"
      }
    }
    return item
  })

  const namedFiles: MultipartFile[] = input.attachments.map((att, index) => {
    const file = files[index]!
    return { ...file, name: `file${index}` }
  })

  const url = `https://api.telegram.org/bot${tokenRecord.token}/sendMediaGroup`
  const { body, contentType } = buildMultipartBody(
    [
      { name: "chat_id", value: chatId },
      { name: "media", value: JSON.stringify(mediaJson) },
    ],
    namedFiles,
  )

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": contentType },
    body: toFetchBody(body),
  })

  return parseTelegramSendResponse(res)
}

/**
 * Parses a Telegram Bot API send response. Telegram's own docs note that,
 * for backward compatibility, some errors are returned with HTTP status 200
 * and `ok: false` in the body rather than a non-2xx status — the exact same
 * class of false positive as agentpush's `status: "blocked"`. Check the
 * body's own `ok` field instead of trusting the HTTP status alone.
 */
async function parseTelegramSendResponse(res: Response): Promise<SendOutboundResult> {
  if (!res.ok) {
    const body = await res.text().catch(() => "")
    return { ok: false, error: `telegram_http_${res.status}: ${body}` }
  }

  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>
  if (json.ok !== true) {
    const description = typeof json.description === "string" ? json.description : "unknown_error"
    return { ok: false, error: `telegram_error: ${description}` }
  }

  return { ok: true, providerMessageId: extractTelegramMessageId(json) }
}

// ── Helpers ─────────────────────────────────────────────────────────────

function extractProviderMessageId(result: unknown): string | undefined {
  if (!result || typeof result !== "object") return undefined
  const typed = result as Record<string, unknown>
  // Common shapes across agentpush implementations.
  if (typeof typed.messageId === "string") return typed.messageId
  if (typeof typed.message_id === "string") return typed.message_id
  if (typeof typed.id === "string") return typed.id
  const nested =
    typeof typed.result === "object" && typed.result !== null
      ? (typed.result as Record<string, unknown>)
      : undefined
  if (typeof nested?.messageId === "string") return nested.messageId
  if (typeof nested?.message_id === "string") return nested.message_id
  if (typeof nested?.id === "string") return nested.id
  return undefined
}

function extractTelegramMessageId(json: Record<string, unknown>): string | undefined {
  const result = json.result
  if (Array.isArray(result) && result.length > 0) {
    const first = result[0] as Record<string, unknown>
    if (typeof first.message_id === "number") return String(first.message_id)
  }
  if (result && typeof result === "object") {
    const typed = result as Record<string, unknown>
    if (typeof typed.message_id === "number") return String(typed.message_id)
  }
  return undefined
}

function mapOutboundTypeToAgentpushType(type: OutboundAttachment["type"]): AgentpushMediaType {
  switch (type) {
    case "photo":
      return "image"
    case "document":
    case "video":
    case "audio":
      return type
  }
}

function telegramMethodForType(type: OutboundAttachment["type"]): string {
  switch (type) {
    case "photo":
      return "sendPhoto"
    case "document":
      return "sendDocument"
    case "video":
      return "sendVideo"
    case "audio":
      return "sendAudio"
  }
}

function telegramMediaTypeFor(type: OutboundAttachment["type"]): string {
  switch (type) {
    case "photo":
      return "photo"
    case "document":
      return "document"
    case "video":
      return "video"
    case "audio":
      return "audio"
  }
}

export function mimeTypeFor(ext: string, kind: OutboundAttachment["type"]): string {
  const e = ext.toLowerCase()
  switch (kind) {
    case "photo":
      if (e === ".png") return "image/png"
      if (e === ".gif") return "image/gif"
      if (e === ".webp") return "image/webp"
      if (e === ".jpg" || e === ".jpeg") return "image/jpeg"
      return "image/jpeg"
    case "video":
      if (e === ".mov") return "video/quicktime"
      if (e === ".webm") return "video/webm"
      return "video/mp4"
    case "audio":
      if (e === ".ogg") return "audio/ogg"
      if (e === ".wav") return "audio/wav"
      if (e === ".m4a" || e === ".mp4") return "audio/mp4"
      return "audio/mpeg"
    case "document":
      if (e === ".pdf") return "application/pdf"
      if (e === ".txt") return "text/plain"
      if (e === ".json") return "application/json"
      if (e === ".html" || e === ".htm") return "text/html"
      if (e === ".csv") return "text/csv"
      return "application/octet-stream"
  }
}

interface MultipartField {
  name: string
  value: string
}

interface MultipartFile {
  name: string
  filename: string
  contentType: string
  data: Buffer
}

function buildMultipartBody(
  fields: MultipartField[],
  files: MultipartFile[],
): { body: Buffer; contentType: string } {
  const boundary = `----AgentprotoBoundary${Math.random().toString(36).slice(2, 11)}`
  const parts: Buffer[] = []
  const crlf = Buffer.from("\r\n")

  for (const field of fields) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${field.name}"\r\n\r\n${field.value}\r\n`,
      ),
    )
  }

  for (const file of files) {
    const safeFilename = file.filename.replace(/"/g, '\\"')
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${file.name}"; filename="${safeFilename}"\r\nContent-Type: ${file.contentType}\r\n\r\n`,
      ),
    )
    parts.push(file.data)
    parts.push(crlf)
  }

  parts.push(Buffer.from(`--${boundary}--\r\n`))
  return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` }
}

/**
 * Converts a Node `Buffer` into a standards-compatible `BodyInit` for `fetch()`.
 *
 * At runtime Node's `Buffer` is a `Uint8Array` subclass and is accepted by
 * `fetch()`, but TypeScript's DOM `BodyInit` types `BufferSource` as
 * `ArrayBufferView<ArrayBuffer>`. `Buffer` is currently typed as
 * `Buffer<ArrayBufferLike>`, whose underlying `buffer` property may be a
 * `SharedArrayBuffer` at the type level, so it is not assignable to
 * `BodyInit` when the DOM lib is in scope. Copying into a plain
 * `Uint8Array` preserves the exact byte sequence while satisfying the
 * standard type.
 */
export function toFetchBody(buffer: Buffer): Uint8Array<ArrayBuffer> {
  return new Uint8Array(buffer)
}

/**
 * Converts Markdown to Telegram MarkdownV2 format.
 *
 * Telegram MarkdownV2 special characters that MUST be escaped outside formatting:
 *   _ * [ ] ( ) ~ ` > # + - = | { } . !
 */
function convertMarkdownToTelegram(text: string): string {
  if (!text) return text

  let result = text

  const codeBlocks: string[] = []
  const inlineCodes: string[] = []

  result = result.replace(/```([\s\S]*?)```/g, (_match, code) => {
    codeBlocks.push(code)
    return `\x00CODEBLOCK${codeBlocks.length - 1}\x00`
  })

  result = result.replace(/`([^`]+?)`/g, (_match, code) => {
    inlineCodes.push(code)
    return `\x00INLINE${inlineCodes.length - 1}\x00`
  })

  result = result.replace(/^#{1,6}\s+(.+?)$/gm, (_match, content) => {
    const clean = content
      .replace(/\*\*(.+?)\*\*/g, "$1")
      .replace(/__(.+?)__/g, "$1")
    return `\x00BOLD\x00${clean.trim()}\x00/BOLD\x00`
  })

  result = result.replace(/\*\*(.+?)\*\*/g, `\x00BOLD\x00$1\x00/BOLD\x00`)
  result = result.replace(/__(.+?)__/g, `\x00BOLD\x00$1\x00/BOLD\x00`)

  result = result.replace(/\*(.+?)\*/g, `\x00ITALIC\x00$1\x00/ITALIC\x00`)
  result = result.replace(/_(.+?)_/g, `\x00ITALIC\x00$1\x00/ITALIC\x00`)

  result = result.replace(/~~(.+?)~~/g, `\x00STRIKE\x00$1\x00/STRIKE\x00`)

  const SPECIAL_CHARS = /([_\*\[\]()~`>#+=|{}.!\-])/g

  const parts = result.split(
    /(\x00(?:BOLD|\/BOLD|ITALIC|\/ITALIC|STRIKE|\/STRIKE|CODEBLOCK\d+|INLINE\d+)\x00)/
  )
  result = parts
    .map(part => {
      if (part.startsWith("\x00") && part.endsWith("\x00")) {
        return part
      }
      return part.replace(SPECIAL_CHARS, "\\$1")
    })
    .join("")

  result = result.replace(/\x00BOLD\x00/g, "*")
  result = result.replace(/\x00\/BOLD\x00/g, "*")
  result = result.replace(/\x00ITALIC\x00/g, "_")
  result = result.replace(/\x00\/ITALIC\x00/g, "_")
  result = result.replace(/\x00STRIKE\x00/g, "~")
  result = result.replace(/\x00\/STRIKE\x00/g, "~")

  result = result.replace(/\x00CODEBLOCK(\d+)\x00/g, (_match, idx) => {
    const code = codeBlocks[parseInt(idx)]!
    return "```" + code.replace(/([`\\])/g, "\\$1") + "```"
  })

  result = result.replace(/\x00INLINE(\d+)\x00/g, (_match, idx) => {
    const code = inlineCodes[parseInt(idx)]!
    return "`" + code.replace(/([`\\])/g, "\\$1") + "`"
  })

  return result
}
