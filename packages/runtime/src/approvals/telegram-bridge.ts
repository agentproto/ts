/**
 * Telegram front-end for the approvals engine.
 *
 * Every `approval:requested` whose record lists the `telegram` channel is sent
 * to the configured chat as a message with Approve / Refuse buttons. A tap from
 * an allowed user in that chat decides the approval in-process through the
 * engine's `telegram` channel, so the usual audit trail and the
 * `approval:decided` relay (for example to Bureau) run unchanged.
 *
 * Same trust rules as `permission-telegram-bridge.ts`: callback data carries an
 * opaque random token (never the approval id), and taps from another user or
 * another chat are refused. When the approval is decided or expires through any
 * other channel, the buttons are stripped and the outcome is appended.
 *
 * Each open card is persisted next to its approval (`telegram-card.json`), so
 * a tap on a card sent before a daemon restart still decides, and a card whose
 * approval was decided while the daemon was down is closed once at `start()`.
 *
 * Nothing here logs the bot token, a chat id or a user id.
 */

import { randomBytes } from "node:crypto"

import type { SessionEventBus } from "../session-event-bus.js"
import type { TelegramBotCredsStore } from "../telegram-bot-creds.js"
import type { ApprovalsEngine } from "./engine.js"
import type { ApprovalRecord } from "./types.js"

const CALLBACK_PREFIX = "apr:"
// Telegram rejects text over 4096 characters. The body leaves room for the
// "... (truncated)" suffix and the outcome line appended when the card closes.
const MAX_BODY_CHARS = 3800
const MAX_FIELD_CHARS = 3000
const TRUNCATED = "... (truncated)"
// Caps for the `{ summary, sections, links }` preview convention, the same
// ones the session-chat approval page applies.
const MAX_SUMMARY_CHARS = 600
const MAX_TITLE_CHARS = 80
const MAX_SECTIONS = 20
const MAX_LABEL_CHARS = 120
const MAX_LINKS = 20
const MAX_URL_CHARS = 2048
const MAX_EXTRA_CHARS = 300

export interface ApprovalTelegramBridgeOptions {
  events: Pick<SessionEventBus, "onAny">
  engine: Pick<
    ApprovalsEngine,
    "get" | "decideTelegram" | "putTelegramCard" | "removeTelegramCard" | "listTelegramCards"
  >
  telegramCreds: TelegramBotCredsStore
  /** Bot credential alias (`telegram_bot_token_set`). */
  alias: string
  /** Chat the cards go to, and the only chat taps are accepted from. */
  chatId: string
  /** Telegram user ids allowed to answer. Required and non-empty. */
  allowedUserIds: readonly string[]
  fetchImpl?: typeof fetch
  onError?: (err: unknown) => void
}

export interface ApprovalTelegramBridge {
  start(): void
  stop(): void
  /** Feed a raw Telegram update. `handled: true` means it was an approval tap
   *  (decided or refused) and must not be processed any further. */
  handleUpdate(update: unknown): Promise<{ handled: boolean }>
}

interface Tracked {
  approvalId: string
  messageId: number
  text: string
}

interface CallbackQuery {
  id: string
  from?: { id?: number | string }
  message?: { message_id?: number; chat?: { id?: number | string } }
  data?: string
}

function clip(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}${TRUNCATED}` : value
}

function renderValue(value: unknown): string {
  if (typeof value === "string") return value
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

interface ConventionSection {
  title: string
  text: string
}

interface ConventionPreview {
  summary: string | undefined
  sections: ConventionSection[]
  links: Array<{ label: string; url: string }>
  /** Top-level keys the convention did not consume, rendered as `key: value`. */
  rest: Array<[string, unknown]>
}

/** The `{ summary?, sections?, links? }` convention the approval page renders,
 *  or undefined when the preview carries none of its three keys. */
function readConvention(preview: unknown): ConventionPreview | undefined {
  if (!isRecord(preview)) return undefined
  const summary = typeof preview.summary === "string" ? preview.summary : undefined
  const sectionsRaw = Array.isArray(preview.sections) ? preview.sections : undefined
  const linksRaw = Array.isArray(preview.links) ? preview.links : undefined
  if (summary === undefined && !sectionsRaw && !linksRaw) return undefined

  const sections: ConventionSection[] = []
  for (const item of sectionsRaw ?? []) {
    if (sections.length >= MAX_SECTIONS) break
    if (!isRecord(item) || typeof item.title !== "string" || typeof item.text !== "string") continue
    sections.push({ title: clip(item.title, MAX_TITLE_CHARS), text: item.text })
  }

  const links: Array<{ label: string; url: string }> = []
  for (const item of linksRaw ?? []) {
    if (links.length >= MAX_LINKS) break
    if (!isRecord(item) || typeof item.url !== "string" || item.url.length > MAX_URL_CHARS) continue
    let https = false
    try {
      https = new URL(item.url).protocol === "https:"
    } catch {
      https = false
    }
    if (!https) continue
    const label = typeof item.label === "string" && item.label.length > 0 ? item.label : item.url
    links.push({ label: clip(label, MAX_LABEL_CHARS), url: item.url })
  }

  const rest = Object.entries(preview).filter(([key]) => {
    if (key === "summary") return summary === undefined
    if (key === "sections") return !sectionsRaw
    if (key === "links") return !linksRaw
    return true
  })
  return { summary, sections, links, rest }
}

/** Water-filling split of `budget` over the texts: a short text keeps its
 *  full length, the long ones share what is left equally. */
function splitBudget(lengths: readonly number[], budget: number): number[] {
  const order = lengths.map((length, index) => ({ length, index })).sort((a, b) => a.length - b.length)
  const alloc: number[] = lengths.map(() => 0)
  let left = Math.max(0, budget)
  order.forEach(({ length, index }, i) => {
    const share = Math.floor(left / (order.length - i))
    alloc[index] = Math.min(length, share)
    left -= alloc[index]!
  })
  return alloc
}

/** Cut `text` so that, marker included, it is at most `max` characters. */
function clipToFit(text: string, max: number): string {
  if (text.length <= max) return text
  return `${text.slice(0, Math.max(0, max - TRUNCATED.length))}${TRUNCATED}`
}

function describeConvention(record: ApprovalRecord, conv: ConventionPreview, tail: string): string {
  const budget = MAX_BODY_CHARS - tail.length - 1
  const summary = conv.summary ? clip(conv.summary, MAX_SUMMARY_CHARS) : undefined
  const seen = [conv.summary ?? "", ...conv.sections.map(s => s.text)]
  const extras: string[] = []
  for (const [key, value] of conv.rest) {
    if (value === undefined || value === null) continue
    if (typeof value === "string" && value.length > 0 && seen.some(text => text.includes(value))) continue
    extras.push(`${key}: ${clip(renderValue(value), MAX_EXTRA_CHARS)}`)
  }

  const assemble = (texts: readonly string[]): string => {
    const blocks: string[] = [`Approval needed: ${record.title}\nKind: ${record.kind}`]
    if (summary) blocks.push(summary)
    conv.sections.forEach((section, i) => {
      blocks.push(texts[i] ? `${section.title}\n${texts[i]}` : section.title)
    })
    if (conv.links.length > 0) blocks.push(conv.links.map(l => `${l.label}: ${l.url}`).join("\n"))
    if (extras.length > 0) blocks.push(extras.join("\n"))
    return blocks.join("\n\n")
  }

  const withheld = conv.sections.map(() => "")
  const nonEmpty = conv.sections.filter(s => s.text.length > 0).length
  const room = budget - assemble(withheld).length - nonEmpty
  const alloc = splitBudget(
    conv.sections.map(s => s.text.length),
    room,
  )
  const texts = conv.sections.map((s, i) => clipToFit(s.text, alloc[i]!))
  // Only the head is ever cut: a pathological pile of links or extra keys must
  // not push Session and Expires out of the card.
  return `${clipToFit(assemble(texts), budget)}\n${tail}`
}

function describeApproval(record: ApprovalRecord): string {
  const by = record.requestedBy
  const footer = ["", "sessionId" in by ? `Session: ${by.sessionId}` : "Requested by the operator"]
  if (record.expiresAt) footer.push(`Expires: ${record.expiresAt}`)
  const tail = footer.join("\n")

  const conv = readConvention(record.preview)
  if (conv) return describeConvention(record, conv, tail)

  const lines = [`Approval needed: ${record.title}`, `Kind: ${record.kind}`]
  const preview = record.preview
  if (preview && typeof preview === "object" && !Array.isArray(preview)) {
    for (const [key, value] of Object.entries(preview as Record<string, unknown>)) {
      if (value === undefined || value === null) continue
      lines.push(`${key}: ${clip(renderValue(value), MAX_FIELD_CHARS)}`)
    }
  } else if (preview !== undefined && preview !== null) {
    lines.push("", clip(renderValue(preview), MAX_FIELD_CHARS))
  }
  // Only the head is cut when the card is too long: Session and Expires stay visible.
  return `${clip(lines.join("\n"), MAX_BODY_CHARS - tail.length - 1)}\n${tail}`
}

export function createApprovalTelegramBridge(opts: ApprovalTelegramBridgeOptions): ApprovalTelegramBridge {
  if (opts.allowedUserIds.length === 0) {
    throw new Error("approval-telegram-bridge: allowedUserIds must list at least one Telegram user id")
  }
  const allowed = new Set(opts.allowedUserIds.map(String))
  const chatId = String(opts.chatId)
  const doFetch = opts.fetchImpl ?? fetch
  const reportError = opts.onError ?? (() => {})

  const byToken = new Map<string, Tracked>()
  const tokenByApproval = new Map<string, string>()
  let unsubscribe: (() => void) | undefined

  async function call(method: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const creds = await opts.telegramCreds.read(opts.alias)
    if (!creds) throw new Error(`approval-telegram-bridge: no Telegram bot token for alias "${opts.alias}"`)
    const res = await doFetch(`https://api.telegram.org/bot${creds.token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
    const json = (await res.json().catch(() => ({}))) as {
      ok?: boolean
      description?: string
      result?: Record<string, unknown>
    }
    if (!res.ok || json.ok !== true) {
      throw new Error(`telegram ${method} failed: ${json.description ?? res.status}`)
    }
    return json.result ?? {}
  }

  function track(token: string, t: Tracked): void {
    byToken.set(token, t)
    tokenByApproval.set(t.approvalId, token)
  }

  function forget(token: string): Tracked | undefined {
    const t = byToken.get(token)
    if (!t) return undefined
    byToken.delete(token)
    tokenByApproval.delete(t.approvalId)
    try {
      opts.engine.removeTelegramCard(t.approvalId)
    } catch (err) {
      reportError(err)
    }
    return t
  }

  async function closeMessage(t: Tracked, status: string): Promise<void> {
    await call("editMessageText", {
      chat_id: chatId,
      message_id: t.messageId,
      text: `${t.text}\n\n${status}`,
      reply_markup: { inline_keyboard: [] },
    })
  }

  function outcomeLine(record: ApprovalRecord): string {
    if (record.status === "expired") return "Expired: nothing was approved."
    const decision = record.decision
    if (!decision) return `No longer pending (${record.status}).`
    return `${decision.decision === "approved" ? "Approved" : "Denied"} via ${decision.channel}.`
  }

  async function finish(approvalId: string, status: string): Promise<void> {
    const token = tokenByApproval.get(approvalId)
    if (!token) return
    const t = forget(token)
    if (!t) return
    await closeMessage(t, status)
  }

  async function announce(approvalId: string): Promise<void> {
    const record = opts.engine.get(approvalId)
    if (!record || record.status !== "pending" || !record.channels.includes("telegram")) return
    const token = randomBytes(6).toString("hex")
    const text = describeApproval(record)
    const result = await call("sendMessage", {
      chat_id: chatId,
      text,
      reply_markup: {
        inline_keyboard: [
          [
            { text: "Approve", callback_data: `${CALLBACK_PREFIX}${token}:a` },
            { text: "Refuse", callback_data: `${CALLBACK_PREFIX}${token}:r` },
          ],
        ],
      },
    })
    const messageId = Number(result.message_id)
    track(token, { approvalId, messageId, text })
    try {
      opts.engine.putTelegramCard({ token, approvalId, messageId, text })
    } catch (err) {
      reportError(err)
    }
    // Decided elsewhere while the send was in flight: its event found nothing to close.
    const now = opts.engine.get(approvalId)
    if (now && now.status !== "pending") await finish(approvalId, outcomeLine(now))
  }

  /** Cards persisted by an earlier run: a still-pending approval is tracked
   *  again; anything else gets its message closed once and its file removed. */
  async function restoreCards(): Promise<void> {
    for (const card of opts.engine.listTelegramCards()) {
      const t: Tracked = { approvalId: card.approvalId, messageId: card.messageId, text: card.text }
      const record = opts.engine.get(card.approvalId)
      if (record && record.status === "pending") {
        if (!tokenByApproval.has(card.approvalId)) track(card.token, t)
        continue
      }
      try {
        await closeMessage(t, record ? outcomeLine(record) : "No longer pending.")
      } catch (err) {
        reportError(err)
      }
      try {
        opts.engine.removeTelegramCard(card.approvalId)
      } catch (err) {
        reportError(err)
      }
    }
  }

  async function answer(queryId: string, text: string): Promise<void> {
    try {
      await call("answerCallbackQuery", { callback_query_id: queryId, text })
    } catch (err) {
      reportError(err)
    }
  }

  return {
    start() {
      if (unsubscribe) return
      unsubscribe = opts.events.onAny(ev => {
        if (ev.type === "approval:requested") {
          announce(ev.approvalId).catch(reportError)
        } else if (ev.type === "approval:decided") {
          finish(ev.approvalId, `${ev.decision === "approved" ? "Approved" : "Denied"} via ${ev.channel}.`).catch(
            reportError,
          )
        } else if (ev.type === "approval:expired") {
          finish(ev.approvalId, "Expired: nothing was approved.").catch(reportError)
        }
      })
      restoreCards().catch(reportError)
    },

    stop() {
      unsubscribe?.()
      unsubscribe = undefined
      byToken.clear()
      tokenByApproval.clear()
    },

    async handleUpdate(update) {
      const cq = (update as { callback_query?: CallbackQuery } | null)?.callback_query
      if (!cq || typeof cq.data !== "string" || !cq.data.startsWith(CALLBACK_PREFIX)) return { handled: false }

      const fromId = cq.from?.id !== undefined ? String(cq.from.id) : ""
      const fromChat = cq.message?.chat?.id !== undefined ? String(cq.message.chat.id) : ""
      if (!allowed.has(fromId) || fromChat !== chatId) {
        await answer(cq.id, "Not authorised.")
        return { handled: true }
      }

      const [token, choice] = cq.data.slice(CALLBACK_PREFIX.length).split(":")
      const t = token ? byToken.get(token) : undefined
      if (!t || (choice !== "a" && choice !== "r")) {
        await answer(cq.id, "Already handled or expired.")
        return { handled: true }
      }

      const approve = choice === "a"
      let decided = false
      try {
        // The `approval:decided` event closes the message (and forgets the token).
        await opts.engine.decideTelegram(t.approvalId, approve ? "approve" : "deny", {
          ipAddress: "telegram",
          userAgent: "agentproto-approval-telegram-bridge",
        })
        decided = true
      } catch (err) {
        reportError(err)
        const now = opts.engine.get(t.approvalId)
        const left = forget(token!)
        if (left) {
          try {
            await closeMessage(left, now ? outcomeLine(now) : "No longer pending.")
          } catch (closeErr) {
            reportError(closeErr)
          }
        }
      }
      await answer(cq.id, decided ? (approve ? "Approved" : "Refused") : "Could not apply (already resolved?)")
      return { handled: true }
    },
  }
}
