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
  return value.length > max ? `${value.slice(0, max)}... (truncated)` : value
}

function renderValue(value: unknown): string {
  if (typeof value === "string") return value
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

function describeApproval(record: ApprovalRecord): string {
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
  const by = record.requestedBy
  const footer = ["", "sessionId" in by ? `Session: ${by.sessionId}` : "Requested by the operator"]
  if (record.expiresAt) footer.push(`Expires: ${record.expiresAt}`)
  const tail = footer.join("\n")
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
