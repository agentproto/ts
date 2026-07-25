/**
 * inbound-adapters — provider-agnostic normalization + signature verification
 * for inbound push ingress. Pure functions, no I/O.
 *
 * Supports the dialects documented in packages/runtime/docs/TRANSMITTER.md.
 */

import { createHmac, timingSafeEqual } from "node:crypto"
import type { InboundMessage } from "./inbound-router.js"

export type InboundProvider =
  | "agentpush"
  | "telegram"
  | "whatsapp"
  | "slack"
  | "generic"
  | "native"

export const INBOUND_PROVIDERS: readonly InboundProvider[] = [
  "agentpush",
  "telegram",
  "whatsapp",
  "slack",
  "generic",
  "native",
]

export type NormalizeInboundResult =
  | { ok: true; msg: InboundMessage; providerMessageId?: string }
  | { ok: true; challenge: string }
  | { ok: false; error: string; message?: string }

export function normalizeInbound(
  provider: InboundProvider,
  body: unknown,
  ctx: { alias: string; sourceOverride?: string },
): NormalizeInboundResult {
  switch (provider) {
    case "agentpush":
      return normalizeAgentpush(body, ctx)
    case "telegram":
      return normalizeTelegram(body, ctx)
    case "whatsapp":
      return normalizeWhatsapp(body, ctx)
    case "slack":
      return normalizeSlack(body, ctx)
    case "generic":
      return normalizeGeneric(body, ctx)
    case "native":
      return normalizeNative(body, ctx)
    default:
      // Exhaustiveness guard — provider is typed, but keep TS happy.
      return { ok: false, error: "unsupported_provider" }
  }
}

export function verifyInboundSignature(
  provider: InboundProvider,
  input: {
    rawBody: string
    headers: Record<string, string | string[] | undefined>
    secret: string
    nowMs: number
  },
): { ok: true } | { ok: false; reason: string } {
  switch (provider) {
    case "agentpush":
      return verifyHmacHexHeader(input, "x-agentpush-signature")
    case "telegram":
      return verifyConstantTimeHeader(input, "x-telegram-bot-api-secret-token")
    case "whatsapp":
      return verifyHmacHexHeader(input, "x-hub-signature-256")
    case "slack":
      return verifySlackSignature(input)
    case "generic":
      return verifyHmacHexHeader(input, "x-agentproto-signature")
    case "native":
      return { ok: false, reason: "native uses the sessions bearer gate" }
    default:
      return { ok: false, reason: "unsupported_provider" }
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────

function hasKey<T extends Record<string, unknown>>(
  obj: T,
  key: string,
): obj is T & Record<string, unknown> {
  return Object.prototype.hasOwnProperty.call(obj, key)
}

function getStringField(
  obj: unknown,
  keys: string[],
): string | undefined {
  if (!obj || typeof obj !== "object") return undefined
  for (const key of keys) {
    if (hasKey(obj as Record<string, unknown>, key)) {
      const value = (obj as Record<string, unknown>)[key]
      if (typeof value === "string") return value
    }
  }
  return undefined
}

function buildMsg(
  body: unknown,
  ctx: { alias: string; sourceOverride?: string },
  fields: {
    source: string | undefined | (() => string | undefined)
    contactRef: string | undefined | (() => string | undefined)
    text: string | undefined | (() => string | undefined)
    providerMessageId?: string | undefined | (() => string | undefined)
  },
): NormalizeInboundResult {
  const source =
    ctx.sourceOverride ??
    (typeof fields.source === "function" ? fields.source() : fields.source)
  const contactRef =
    typeof fields.contactRef === "function"
      ? fields.contactRef()
      : fields.contactRef
  const text =
    typeof fields.text === "function" ? fields.text() : fields.text
  const providerMessageId =
    typeof fields.providerMessageId === "function"
      ? fields.providerMessageId()
      : fields.providerMessageId

  if (!source) return { ok: false, error: "missing_source" }
  if (!contactRef) return { ok: false, error: "missing_contact_ref" }
  if (!text) return { ok: false, error: "no_text" }

  const msg: InboundMessage = {
    alias: ctx.alias,
    source,
    contactRef,
    text,
    ...(Array.isArray(body) ? { messages: body } : {}),
  }

  return { ok: true, msg, providerMessageId }
}

// ── agentpush ───────────────────────────────────────────────────────────

function normalizeAgentpush(
  body: unknown,
  ctx: { alias: string; sourceOverride?: string },
): NormalizeInboundResult {
  if (!body || typeof body !== "object") {
    return { ok: false, error: "invalid_json" }
  }

  const envelope = body as Record<string, unknown>

  // Webhook handshake — echo the challenge, do not route.
  if (typeof envelope.challenge === "string") {
    return { ok: true, challenge: envelope.challenge }
  }

  const source =
    ctx.sourceOverride ??
    (typeof envelope.channel === "string" ? envelope.channel : undefined)
  const contactRef =
    typeof envelope.from === "string" ? envelope.from : undefined
  const text = typeof envelope.text === "string" ? envelope.text : undefined
  const providerMessageId =
    typeof envelope.messageId === "string" ? envelope.messageId : undefined

  if (!source) return { ok: false, error: "missing_source" }
  if (!contactRef) return { ok: false, error: "missing_contact_ref" }
  if (!text) return { ok: false, error: "no_text" }

  return {
    ok: true,
    msg: {
      alias: ctx.alias,
      source,
      contactRef,
      text,
      messages: [envelope],
    },
    providerMessageId,
  }
}

// ── telegram ────────────────────────────────────────────────────────────

function normalizeTelegram(
  body: unknown,
  ctx: { alias: string; sourceOverride?: string },
): NormalizeInboundResult {
  if (!body || typeof body !== "object") {
    return { ok: false, error: "invalid_json" }
  }

  const typed = body as Record<string, unknown>
  const message =
    typed && typeof typed.message === "object" && typed.message !== null
      ? (typed.message as Record<string, unknown>)
      : undefined

  if (!message) {
    return { ok: false, error: "missing_message" }
  }

  const chat =
    typeof message.chat === "object" && message.chat !== null
      ? (message.chat as Record<string, unknown>)
      : undefined

  const from =
    typeof message.from === "object" && message.from !== null
      ? (message.from as Record<string, unknown>)
      : undefined

  // Ignore bot messages and messages sent by the bot to itself.
  if (from?.is_bot === true || message.from === message.chat) {
    return {
      ok: false,
      error: "bot_or_self_message",
      message: "bot or self message",
    }
  }

  const source =
    ctx.sourceOverride ??
    (chat && typeof chat.id === "number"
      ? String(chat.id)
      : undefined)
  const contactRef = source
  const text = typeof message.text === "string" ? message.text : undefined
  const providerMessageId =
    typeof message.message_id === "number"
      ? String(message.message_id)
      : undefined

  return buildMsg(body, ctx, {
    source,
    contactRef,
    text,
    providerMessageId,
  })
}

// ── whatsapp ────────────────────────────────────────────────────────────

function normalizeWhatsapp(
  body: unknown,
  ctx: { alias: string; sourceOverride?: string },
): NormalizeInboundResult {
  if (!body || typeof body !== "object") {
    return { ok: false, error: "invalid_json" }
  }

  const entries =
    Array.isArray((body as Record<string, unknown>).entry)
      ? ((body as Record<string, unknown>).entry as unknown[])
      : []

  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue
    const typedEntry = entry as Record<string, unknown>
    const changes =
      Array.isArray(typedEntry.changes)
        ? (typedEntry.changes as unknown[])
        : []

    for (const change of changes) {
      if (!change || typeof change !== "object") continue
      const typedChange = change as Record<string, unknown>
      const value =
        typeof typedChange.value === "object" && typedChange.value !== null
          ? (typedChange.value as Record<string, unknown>)
          : undefined
      if (!value) continue

      const messages =
        Array.isArray(value.messages) ? (value.messages as unknown[]) : []

      for (const msg of messages) {
        if (!msg || typeof msg !== "object") continue
        const typedMsg = msg as Record<string, unknown>
        const from =
          typeof typedMsg.from === "string" ? typedMsg.from : undefined

        const textObj =
          typeof typedMsg.text === "object" && typedMsg.text !== null
            ? (typedMsg.text as Record<string, unknown>)
            : undefined
        const text =
          typeof textObj?.body === "string" ? textObj.body : undefined
        const providerMessageId =
          typeof typedMsg.id === "string" ? typedMsg.id : undefined

        if (!from) continue
        if (!text) continue

        return buildMsg(body, ctx, {
          source: ctx.sourceOverride ?? from,
          contactRef: from,
          text,
          providerMessageId,
        })
      }
    }
  }

  return { ok: false, error: "no_text" }
}

// ── slack ─────────────────────────────────────────────────────────────────

function normalizeSlack(
  body: unknown,
  ctx: { alias: string; sourceOverride?: string },
): NormalizeInboundResult {
  if (!body || typeof body !== "object") {
    return { ok: false, error: "invalid_json" }
  }

  const typed = body as Record<string, unknown>

  // URL verification handshake — echo the challenge, do not route.
  if (typed.type === "url_verification") {
    const challenge =
      typeof typed.challenge === "string" ? typed.challenge : undefined
    if (!challenge) return { ok: false, error: "missing_challenge" }
    return { ok: true, challenge }
  }

  if (typed.type !== "event_callback") {
    return { ok: false, error: "not_event_callback" }
  }

  const event =
    typeof typed.event === "object" && typed.event !== null
      ? (typed.event as Record<string, unknown>)
      : undefined

  if (!event) {
    return { ok: false, error: "missing_event" }
  }

  // Ignore bot and self messages.
  if (event.bot_id !== undefined || event.subtype !== undefined) {
    return { ok: false, error: "no_text", message: "bot or self message" }
  }

  if (event.type !== "message") {
    return { ok: false, error: "no_text" }
  }

  const source =
    ctx.sourceOverride ??
    (typeof event.channel === "string" ? event.channel : undefined)
  const contactRef =
    typeof event.user === "string" ? event.user : undefined
  const text = typeof event.text === "string" ? event.text : undefined
  const providerMessageId =
    typeof event.ts === "string" || typeof event.ts === "number"
      ? String(event.ts)
      : undefined

  return buildMsg(body, ctx, {
    source,
    contactRef,
    text,
    providerMessageId,
  })
}

// ── generic ───────────────────────────────────────────────────────────────

function normalizeGeneric(
  body: unknown,
  ctx: { alias: string; sourceOverride?: string },
): NormalizeInboundResult {
  if (!body || typeof body !== "object") {
    return { ok: false, error: "invalid_json" }
  }

  const source =
    ctx.sourceOverride ??
    getStringField(body, ["channel", "source"])
  const contactRef = getStringField(body, ["from", "sender", "contact_ref"])
  const text = getStringField(body, ["text", "body", "message"])
  const providerMessageId = getStringField(body, ["provider_message_id", "message_id", "id"])

  return buildMsg(body, ctx, {
    source,
    contactRef,
    text,
    providerMessageId,
  })
}

// ── native ────────────────────────────────────────────────────────────────

function normalizeNative(
  body: unknown,
  ctx: { alias: string; sourceOverride?: string },
): NormalizeInboundResult {
  if (!body || typeof body !== "object") {
    return { ok: false, error: "invalid_json" }
  }

  const typed = body as Record<string, unknown>
  const source =
    ctx.sourceOverride ??
    (typeof typed.source === "string" ? typed.source : undefined)
  const contactRef =
    typeof typed.contact_ref === "string" ? typed.contact_ref : undefined
  const text = typeof typed.text === "string" ? typed.text : undefined

  return buildMsg(body, ctx, {
    source,
    contactRef,
    text,
  })
}

// ── Signature verification primitives ────────────────────────────────────

function headerValue(
  headers: Record<string, string | string[] | undefined>,
  key: string,
): string | undefined {
  const value = headers[key.toLowerCase()]
  if (Array.isArray(value)) return value[0]
  return value
}

function hexDigest(algorithm: string, secret: string, rawBody: string): string {
  return createHmac(algorithm, secret).update(rawBody, "utf8").digest("hex")
}

function constantTimeHexEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  const aBuf = Buffer.from(a, "hex")
  const bBuf = Buffer.from(b, "hex")
  if (aBuf.length !== bBuf.length) return false
  if (aBuf.length === 0) return false
  return timingSafeEqual(aBuf, bBuf)
}

function verifyHmacHexHeader(
  input: {
    rawBody: string
    headers: Record<string, string | string[] | undefined>
    secret: string
  },
  headerName: string,
  prefix?: string,
): { ok: true } | { ok: false; reason: string } {
  const header = headerValue(input.headers, headerName)
  if (!header) return { ok: false, reason: `missing ${headerName}` }

  const expectedPrefix = prefix ? `${prefix}=` : "sha256="
  if (!header.startsWith(expectedPrefix)) {
    return { ok: false, reason: `bad ${headerName} format` }
  }

  const hex = header.slice(expectedPrefix.length)
  if (!/^[0-9a-fA-F]+$/.test(hex)) {
    return { ok: false, reason: `bad ${headerName} hex` }
  }

  const expected = hexDigest("sha256", input.secret, input.rawBody)
  if (!constantTimeHexEquals(expected, hex)) {
    return { ok: false, reason: `bad ${headerName}` }
  }

  return { ok: true }
}

function verifyConstantTimeHeader(
  input: {
    headers: Record<string, string | string[] | undefined>
    secret: string
  },
  headerName: string,
): { ok: true } | { ok: false; reason: string } {
  const header = headerValue(input.headers, headerName)
  if (!header) return { ok: false, reason: `missing ${headerName}` }

  const secretBuf = Buffer.from(input.secret, "utf8")
  const headerBuf = Buffer.from(header, "utf8")
  if (secretBuf.length !== headerBuf.length) {
    return { ok: false, reason: `bad ${headerName}` }
  }
  if (secretBuf.length === 0) {
    return { ok: false, reason: `bad ${headerName}` }
  }

  return timingSafeEqual(secretBuf, headerBuf)
    ? { ok: true }
    : { ok: false, reason: `bad ${headerName}` }
}

function verifySlackSignature(
  input: {
    rawBody: string
    headers: Record<string, string | string[] | undefined>
    secret: string
    nowMs: number
  },
): { ok: true } | { ok: false; reason: string } {
  const signature = headerValue(input.headers, "x-slack-signature")
  if (!signature) return { ok: false, reason: "missing x-slack-signature" }

  const timestampHeader = headerValue(input.headers, "x-slack-request-timestamp")
  if (!timestampHeader) return { ok: false, reason: "missing x-slack-request-timestamp" }

  const timestamp = Number.parseInt(timestampHeader, 10)
  if (!Number.isFinite(timestamp)) {
    return { ok: false, reason: "bad x-slack-request-timestamp" }
  }

  // Reject requests older than 5 minutes to protect against replay.
  if (input.nowMs - timestamp * 1000 > 5 * 60 * 1000) {
    return { ok: false, reason: "slack replay window expired" }
  }

  if (!signature.startsWith("v0=")) {
    return { ok: false, reason: "bad x-slack-signature format" }
  }

  const hex = signature.slice(3)
  if (!/^[0-9a-fA-F]+$/.test(hex)) {
    return { ok: false, reason: "bad x-slack-signature hex" }
  }

  const baseString = `v0:${timestampHeader}:${input.rawBody}`
  const expected = createHmac("sha256", input.secret).update(baseString, "utf8").digest("hex")

  if (!constantTimeHexEquals(expected, hex)) {
    return { ok: false, reason: "bad x-slack-signature" }
  }

  return { ok: true }
}
