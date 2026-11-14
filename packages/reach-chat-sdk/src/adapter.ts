/**
 * The `chat-sdk` adapter kind: reaches a human through a Chat SDK messenger
 * adapter (Vercel `chat`). First platform: WhatsApp Cloud API, outbound only,
 * `tell` only.
 *
 * Rules measured by the 2026-11-12 spike, followed here:
 * - the bot is built and `initialize()`d once, with `createMemoryState()`,
 *   before the first post (without state, `post` throws AFTER the message
 *   went out);
 * - the recipient is addressed with `adapter.openDM(to)` then
 *   `bot.thread(id)`, never `bot.openDM` (it rejects a `wa_id`);
 * - a throw once `thread.post` has started may have sent: the receipt is
 *   `failed(maybe-sent)`, never `undelivered` (Meta's 131047 refusal, outside
 *   the 24 h window, is the one throw known to have sent nothing). A throw
 *   before it (building or initializing the bot, opening the DM) is
 *   `failed(send-failed)`: no request left. Only public Chat SDK surface is
 *   used, so the phase is ours, not a hook into the adapter's internals.
 *
 * The WhatsApp adapter demands `appSecret` and `verifyToken` even outbound
 * only. No webhook is ever served here, so both are random values made per
 * instance and never configured. The Graph base URL, the bot name and the
 * logger are passed explicitly, so no `WHATSAPP_*` environment variable can
 * redirect the token or add a log line. The adapter's own logger is silent:
 * it would log the phone number id and Meta's error text.
 *
 * Neither the token, the phone number id, the recipient nor any Meta error
 * text is ever put in a receipt or a log line.
 */

import { randomBytes } from "node:crypto"

import type {
  ReachAdapter,
  ReachCapabilities,
  ReachChatSdkRouteEntry,
  ReachMessage,
  ReachReceipt,
  ReachReceiptBody,
} from "@agentproto/reach"
import { createMemoryState } from "@chat-adapter/state-memory"
import { createWhatsAppAdapter } from "@chat-adapter/whatsapp"
import { Chat, type Logger } from "chat"

export const DEFAULT_CHAT_SDK_TIMEOUT_MS = 10_000

/** WhatsApp's text limit: one message, never split. */
export const WHATSAPP_MAX_CHARS = 4096

/** Meta error code for a free-form message outside the 24 h customer
 *  service window. */
export const WHATSAPP_OUTSIDE_WINDOW_ERROR = 131047

export const CHAT_SDK_WHATSAPP_CAPABILITIES: ReachCapabilities = {
  maxChars: WHATSAPP_MAX_CHARS,
  actions: 0,
  files: false,
  link: true,
  defers: false,
  retracts: false,
  identity: false,
}

const GRAPH_API_URL = "https://graph.facebook.com"

export interface ChatSdkReachAdapterDeps {
  now?: () => Date
}

/** Why an entry cannot be used, or undefined when it can. Fixed reasons
 *  only: never a value from the entry. */
export function chatSdkEntryProblem(entry: Record<string, unknown>): string | undefined {
  if (entry.platform !== "whatsapp") return "unknown-platform"
  if (typeof entry.to !== "string" || !/^\d{6,15}$/.test(entry.to)) return "invalid-to"
  const wa = entry.whatsapp
  if (wa === null || typeof wa !== "object" || Array.isArray(wa)) return "missing-whatsapp"
  const { phoneNumberId, accessToken } = wa as Record<string, unknown>
  if (typeof phoneNumberId !== "string" || !/^\d+$/.test(phoneNumberId)) return "invalid-phone-number-id"
  if (typeof accessToken !== "string" || accessToken.trim() === "") return "missing-access-token"
  const timeoutMs = entry.timeoutMs
  if (timeoutMs !== undefined && !(typeof timeoutMs === "number" && Number.isInteger(timeoutMs) && timeoutMs > 0)) {
    return "invalid-timeout"
  }
  return undefined
}

/** The one text a `tell` posts: the summary, then each link on its own
 *  line, cut to {@link WHATSAPP_MAX_CHARS}. */
export function renderWhatsAppText(message: Pick<ReachMessage, "summary" | "links">): string {
  const lines = [message.summary, ...(message.links ?? []).map(l => `${l.label}: ${l.url}`)]
  const text = lines.join("\n")
  return text.length <= WHATSAPP_MAX_CHARS ? text : `${text.slice(0, WHATSAPP_MAX_CHARS - 1)}…`
}

const silentLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return silentLogger
  },
}

interface Bot {
  /** Resolves the recipient's thread, with no request. Its `post` issues
   *  the one Graph request. */
  open(): Promise<{ post(text: string): Promise<unknown> }>
}

function buildBot(entry: ReachChatSdkRouteEntry): Promise<Bot> {
  const adapter = createWhatsAppAdapter({
    accessToken: entry.whatsapp.accessToken,
    phoneNumberId: entry.whatsapp.phoneNumberId,
    appSecret: randomBytes(32).toString("hex"),
    verifyToken: randomBytes(32).toString("hex"),
    apiUrl: GRAPH_API_URL,
    userName: "agentproto",
    logger: silentLogger,
  })
  const bot = new Chat({
    userName: "agentproto",
    adapters: { whatsapp: adapter },
    state: createMemoryState(),
    logger: silentLogger,
  })
  return (async () => {
    await bot.initialize()
    return {
      async open() {
        const thread = bot.thread(await adapter.openDM(entry.to))
        return { post: (text: string) => thread.post({ raw: text }) }
      },
    }
  })()
}

function isOutsideWindow(err: unknown): boolean {
  return (
    err !== null &&
    typeof err === "object" &&
    (err as { errorCode?: unknown }).errorCode === WHATSAPP_OUTSIDE_WINDOW_ERROR
  )
}

export function createChatSdkReachAdapter(
  entry: ReachChatSdkRouteEntry,
  deps: ChatSdkReachAdapterDeps = {},
): ReachAdapter {
  const problem = chatSdkEntryProblem(entry as unknown as Record<string, unknown>)
  if (problem) throw new Error(`reach-chat-sdk: route entry ${entry.id} is not usable (${problem})`)
  const now = deps.now ?? (() => new Date())
  const timeoutMs = entry.timeoutMs ?? DEFAULT_CHAT_SDK_TIMEOUT_MS
  const delivered = new Set<string>()
  let bot: Promise<Bot> | undefined

  const receipt = (body: ReachReceiptBody): ReachReceipt =>
    ({ ...body, adapterId: entry.id, at: now().toISOString() }) as ReachReceipt

  async function tell(message: ReachMessage): Promise<ReachReceiptBody> {
    let thread: Awaited<ReturnType<Bot["open"]>>
    try {
      bot ??= buildBot(entry).catch(err => {
        bot = undefined
        throw err
      })
      thread = await (await bot).open()
    } catch {
      return { status: "failed", reason: "send-failed" }
    }
    try {
      await thread.post(renderWhatsAppText(message))
    } catch (err) {
      if (isOutsideWindow(err)) return { status: "undelivered", reason: "outside-24h-window" }
      return { status: "failed", reason: "maybe-sent" }
    }
    delivered.add(message.dedupeKey)
    return { status: "delivered" }
  }

  return {
    id: entry.id,
    kind: "chat-sdk",
    capabilities: CHAT_SDK_WHATSAPP_CAPABILITIES,
    async send(message) {
      if (message.intent === "ask") return receipt({ status: "undelivered", reason: "ask-not-supported" })
      if (delivered.has(message.dedupeKey)) return receipt({ status: "deduped" })
      let timer: ReturnType<typeof setTimeout> | undefined
      const timedOut = new Promise<ReachReceiptBody>(resolve => {
        timer = setTimeout(() => resolve({ status: "failed", reason: "timeout" }), timeoutMs)
      })
      try {
        return receipt(await Promise.race([tell(message), timedOut]))
      } finally {
        clearTimeout(timer)
      }
    },
  }
}
