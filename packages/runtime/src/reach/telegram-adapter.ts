/**
 * The `telegram` adapter kind: the daemon's own approval bridge
 * (`approvals/telegram-bridge.ts`), wrapped where it is. It is the floor: no
 * dependency outside the runtime, it talks only to `api.telegram.org`.
 *
 * It answers for an approval `ask` only (`ask.ref` is the approval id). The
 * card text, the buttons and the close on decided or expired stay the
 * bridge's own; this adapter has no `close`.
 */

import type { ReachAdapter, ReachCapabilities, ReachMessage, ReachReceipt, ReachReceiptBody } from "@agentproto/reach"

import type { ApprovalTelegramBridge } from "../approvals/telegram-bridge.js"

export const TELEGRAM_REACH_CAPABILITIES: ReachCapabilities = {
  maxChars: 4096,
  actions: 2,
  files: true,
  link: false,
  defers: false,
  retracts: true,
  identity: true,
}

/** What the adapter needs of the bridge. `tell` is optional so a bridge that
 *  only announces approvals still fits: a tell then answers `undelivered`. */
export type TelegramReachBridge = Pick<ApprovalTelegramBridge, "announce"> & Partial<Pick<ApprovalTelegramBridge, "tell">>

/** The plain text of a tell: the summary, then each link on its own line. */
function tellText(message: ReachMessage): string {
  const lines = [message.summary]
  for (const link of message.links ?? []) lines.push(link.label === link.url ? link.url : `${link.label}: ${link.url}`)
  return lines.join("\n")
}

export interface TelegramReachAdapterOptions {
  id: string
  /** The route entry's alias. Absent: the bridge's own. */
  alias?: string
  /** Absent (or resolving to undefined) when the daemon has no Telegram
   *  approval cards configured. A function is read at send time, so the route
   *  can be built before the bridge. */
  bridge?: TelegramReachBridge | (() => TelegramReachBridge | undefined)
  /** The alias the bridge was built with. */
  bridgeAlias?: string
  onError?: (err: unknown) => void
  now?: () => Date
}

export function createTelegramReachAdapter(opts: TelegramReachAdapterOptions): ReachAdapter {
  const now = opts.now ?? (() => new Date())
  const receipt = (body: ReachReceiptBody): ReachReceipt =>
    ({ ...body, adapterId: opts.id, at: now().toISOString() }) as ReachReceipt
  return {
    id: opts.id,
    kind: "telegram",
    capabilities: TELEGRAM_REACH_CAPABILITIES,
    async send(message) {
      const bridge = typeof opts.bridge === "function" ? opts.bridge() : opts.bridge
      if (!bridge) return receipt({ status: "undelivered", reason: "telegram-not-configured" })
      if (opts.alias !== undefined && opts.alias !== (opts.bridgeAlias ?? "default")) {
        return receipt({ status: "undelivered", reason: "alias-not-configured" })
      }
      if (message.intent === "tell") {
        if (!bridge.tell) return receipt({ status: "undelivered", reason: "tell-not-supported" })
        try {
          await bridge.tell(tellText(message))
          return receipt({ status: "delivered" })
        } catch (err) {
          opts.onError?.(err)
          return receipt({ status: "failed", reason: "telegram-send-failed" })
        }
      }
      const ref = message.intent === "ask" ? message.ask?.ref : undefined
      if (!ref) return receipt({ status: "undelivered", reason: "not-an-approval" })
      try {
        const result = await bridge.announce(ref)
        if (result.posted) return receipt({ status: "delivered" })
        if (result.reason === "already-posted") return receipt({ status: "deduped" })
        return receipt({ status: "undelivered", reason: result.reason })
      } catch (err) {
        // The bridge's error goes to the daemon log through onError; the
        // receipt keeps a fixed reason so no Telegram text lands in reach.json.
        opts.onError?.(err)
        return receipt({ status: "failed", reason: "telegram-send-failed" })
      }
    },
  }
}
