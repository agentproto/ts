/**
 * Telegram front-end for the pending-permissions inbox.
 *
 * Every permission parked on one of the configured tools (default
 * `send_message`) is mirrored as a Telegram message with two tap buttons;
 * a tap from an allowed user in the configured chat resolves the pending
 * permission through `respondPermission` (`allow_once` / `reject_once`).
 *
 * The inbox stays the source of truth: the CLI / `permissions_respond` keep
 * working, and when the permission is resolved from there the buttons are
 * stripped. A Telegram outage never blocks anything beyond the permission's
 * own timeout, which fails closed.
 */

import { randomBytes } from "node:crypto"
import type { SessionEventBus } from "./session-event-bus.js"
import type { PendingPermission, PermissionRespondInput, PermissionRespondResult } from "./sessions.js"
import type { TelegramBotCredsStore } from "./telegram-bot-creds.js"

export const DEFAULT_BRIDGED_TOOLS: readonly string[] = ["send_message"]

const CALLBACK_PREFIX = "perm:"
const MAX_BODY_CHARS = 2500

export interface PermissionTelegramBridgeOptions {
  events: Pick<SessionEventBus, "onAny">
  registry: {
    listPendingPermissions(): PendingPermission[]
    respondPermission(id: string, input: PermissionRespondInput): Promise<PermissionRespondResult>
  }
  telegramCreds: TelegramBotCredsStore
  /** Bot credential alias (`telegram_bot_token_set`). */
  alias: string
  /** Chat the approval messages go to, and the only chat taps are accepted from. */
  chatId: string
  /** Telegram user ids allowed to answer. Required and non-empty. */
  allowedUserIds: readonly string[]
  /** Tool names that get a Telegram approval. Default `["send_message"]`. */
  tools?: readonly string[]
  fetchImpl?: typeof fetch
  onError?: (err: unknown) => void
}

export interface PermissionTelegramBridge {
  start(): void
  stop(): void
  /** Feed a raw Telegram update. `handled: true` means it was a permission
   *  tap (answered or refused) and must not be processed any further. */
  handleUpdate(update: unknown): Promise<{ handled: boolean }>
}

interface Tracked {
  permissionId: string
  messageId: number
  text: string
}

interface CallbackQuery {
  id: string
  from?: { id?: number | string }
  message?: { message_id?: number; chat?: { id?: number | string } }
  data?: string
}

function describe(p: PendingPermission): string {
  const raw = p.rawInput as { alias?: unknown; args?: unknown } | undefined
  const lines = [`Approval needed: ${p.toolName ?? "tool call"}`]
  if (raw && typeof raw === "object" && typeof raw.alias === "string") lines.push(`Server: ${raw.alias}`)
  lines.push(`Session: ${p.sessionId}`)
  const payload = raw && typeof raw === "object" && "args" in raw ? raw.args : p.rawInput
  if (payload !== undefined) {
    let body: string
    try {
      body = JSON.stringify(payload, null, 2) ?? String(payload)
    } catch {
      body = String(payload)
    }
    if (body.length > MAX_BODY_CHARS) body = `${body.slice(0, MAX_BODY_CHARS)}\n... (truncated)`
    lines.push("", body)
  } else {
    lines.push("", p.text)
  }
  return lines.join("\n")
}

export function createPermissionTelegramBridge(opts: PermissionTelegramBridgeOptions): PermissionTelegramBridge {
  if (opts.allowedUserIds.length === 0) {
    throw new Error("permission-telegram-bridge: allowedUserIds must list at least one Telegram user id")
  }
  const allowed = new Set(opts.allowedUserIds.map(String))
  const tools = new Set(opts.tools ?? DEFAULT_BRIDGED_TOOLS)
  const chatId = String(opts.chatId)
  const doFetch = opts.fetchImpl ?? fetch
  const reportError = opts.onError ?? (() => {})

  const byToken = new Map<string, Tracked>()
  const tokenByPermission = new Map<string, string>()
  let unsubscribe: (() => void) | undefined

  async function call(method: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const creds = await opts.telegramCreds.read(opts.alias)
    if (!creds) throw new Error(`permission-telegram-bridge: no Telegram bot token for alias "${opts.alias}"`)
    const res = await doFetch(`https://api.telegram.org/bot${creds.token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
    const json = (await res.json().catch(() => ({}))) as { ok?: boolean; description?: string; result?: Record<string, unknown> }
    if (!res.ok || json.ok !== true) {
      throw new Error(`telegram ${method} failed: ${json.description ?? res.status}`)
    }
    return json.result ?? {}
  }

  function forget(token: string): Tracked | undefined {
    const t = byToken.get(token)
    if (!t) return undefined
    byToken.delete(token)
    tokenByPermission.delete(t.permissionId)
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

  async function announce(permissionId: string): Promise<void> {
    const p = opts.registry.listPendingPermissions().find(x => x.id === permissionId)
    if (!p || !p.toolName || !tools.has(p.toolName)) return
    const token = randomBytes(6).toString("hex")
    const text = describe(p)
    const result = await call("sendMessage", {
      chat_id: chatId,
      text,
      reply_markup: {
        inline_keyboard: [
          [
            { text: "Allow once", callback_data: `${CALLBACK_PREFIX}${token}:a` },
            { text: "Reject", callback_data: `${CALLBACK_PREFIX}${token}:r` },
          ],
        ],
      },
    })
    const messageId = Number(result.message_id)
    byToken.set(token, { permissionId, messageId, text })
    tokenByPermission.set(permissionId, token)
  }

  async function onResolved(permissionId: string, decision: string): Promise<void> {
    const token = tokenByPermission.get(permissionId)
    if (!token) return
    const t = forget(token)
    if (!t) return
    await closeMessage(t, decision === "cancelled" ? "Expired or cancelled: nothing was sent." : `Resolved elsewhere: ${decision}.`)
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
        if (ev.type === "session:permission-request") {
          announce(ev.permissionId).catch(reportError)
        } else if (ev.type === "session:permission-resolved") {
          onResolved(ev.permissionId, ev.decision).catch(reportError)
        }
      })
    },

    stop() {
      unsubscribe?.()
      unsubscribe = undefined
      byToken.clear()
      tokenByPermission.clear()
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
      const t = token ? forget(token) : undefined
      if (!t || (choice !== "a" && choice !== "r")) {
        await answer(cq.id, "Already handled or expired.")
        return { handled: true }
      }

      const approve = choice === "a"
      let result: PermissionRespondResult | undefined
      try {
        result = await opts.registry.respondPermission(t.permissionId, {
          decision: approve ? "approve" : "deny",
          optionId: approve ? "allow_once" : "reject_once",
          scope: "once",
        })
      } catch (err) {
        reportError(err)
      }
      const ok = result?.ok === true
      await answer(cq.id, ok ? (approve ? "Allowed" : "Rejected") : "Could not apply (already resolved?)")
      try {
        await closeMessage(
          t,
          ok ? (approve ? "Allowed once." : "Rejected: nothing was sent.") : "No longer pending.",
        )
      } catch (err) {
        reportError(err)
      }
      return { handled: true }
    },
  }
}
