/**
 * MCP tools of the device pairing binding (device-access.ts):
 *
 *   device_offer          create a one-time connection link (scope = the apps it opens)
 *   device_pair_pending   what is waiting for a human confirmation (no secrets)
 *
 * Listing, renaming and revoking devices are the existing `device_list`,
 * `device_rename` and `device_revoke` tools: an app-scoped device is a device
 * like any other. There is deliberately NO tool that confirms a request or
 * widens a device's apps: the confirmation belongs to a human channel, and
 * more access means a new offer.
 *
 * By default the link goes to the person on Telegram and the tool answers
 * without the code, so the secret never enters a model's context.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"

import type { AppRegistry } from "./app-registry.js"
import { buildPairingLinks, getDeviceAccessStore } from "./device-access.js"

export interface TelegramLinkSender {
  send(input: { text: string; buttonText: string; url: string }): Promise<void>
}

export interface RegisterDeviceAccessToolsOptions {
  appRegistry: AppRegistry
  /** Delivers the link as a message with a button; absent = no Telegram set up. */
  telegram?: TelegramLinkSender
  /** The machine's name shown in the message. */
  machineName: string
  /** Is a confirmation channel available (approvals engine on)? */
  confirmationAvailable: boolean
}

function text(value: object): { content: Array<{ type: "text"; text: string }> } {
  return { content: [{ type: "text", text: JSON.stringify(value) }] }
}

function fail(message: string): { isError: true; content: Array<{ type: "text"; text: string }> } {
  return { isError: true, content: [{ type: "text", text: message }] }
}

/** A Telegram sender over the Bot API (`sendMessage` with one URL button). */
export function createTelegramLinkSender(input: {
  readToken: () => Promise<string | null>
  chatId: string
  fetch?: typeof fetch
}): TelegramLinkSender {
  const doFetch = input.fetch ?? fetch
  return {
    async send({ text: body, buttonText, url }) {
      const token = await input.readToken()
      if (!token) throw new Error("no Telegram bot token configured")
      const res = await doFetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: input.chatId,
          text: body,
          disable_web_page_preview: true,
          protect_content: true,
          reply_markup: { inline_keyboard: [[{ text: buttonText, url }]] },
        }),
      })
      const json = (await res.json().catch(() => ({}))) as { ok?: boolean; description?: string }
      if (!res.ok || json.ok !== true) throw new Error(`telegram sendMessage failed: ${json.description ?? res.status}`)
    },
  }
}

export function registerDeviceAccessTools(server: McpServer, opts: RegisterDeviceAccessToolsOptions): void {
  server.tool(
    "device_offer",
    "PRIVILEGED — create a one-time connection link for a new device (phone app). The device that opens it " +
      "asks for access and shows a number; a human must confirm on the machine's confirmation channel " +
      "(Telegram card) by comparing that number before anything is granted. `apps` is \"*\" (every app with a UI) " +
      "or the exact app ids the device may open; the control of the whole machine is never granted. The link is " +
      "valid 10 minutes by default and works once. `deliver: \"telegram\"` (default when Telegram is set up) " +
      "sends it as a message with a button and answers WITHOUT the link; `deliver: \"return\"` returns the link " +
      "(a secret: never log or repeat it). Manage devices with device_list / device_rename / device_revoke.",
    {
      apps: z
        .union([z.literal("*"), z.array(z.string().min(1)).min(1)])
        .describe('"*" for every app with a UI, or the app ids the device may open.'),
      sessionsRead: z.boolean().optional().describe("Also allow reading the daemon's session routes (a chat viewer needs it)."),
      baseUrl: z
        .string()
        .optional()
        .describe("Public https URL of this daemon (its tunnel). Default: $AGENTPROTO_PUBLIC_HTTP_ORIGIN."),
      ttlMinutes: z.number().int().min(1).max(60).optional().describe("Link lifetime in minutes. Default 10."),
      label: z.string().max(80).optional().describe("Name shown for the device if it does not give one."),
      deliver: z.enum(["telegram", "return"]).optional(),
    },
    async ({ apps, sessionsRead, baseUrl, ttlMinutes, label, deliver }) => {
      if (!opts.confirmationAvailable) {
        return fail(
          "device_offer: this daemon has no confirmation channel (approvals are off), so a new device could not " +
            "be confirmed. Turn on approvals (and the Telegram cards) first.",
        )
      }
      const wanted = deliver ?? (opts.telegram ? "telegram" : "return")
      if (wanted === "telegram" && !opts.telegram) {
        return fail('device_offer: Telegram is not set up on this daemon; use deliver: "return".')
      }
      const base = baseUrl ?? process.env.AGENTPROTO_PUBLIC_HTTP_ORIGIN
      if (!base) {
        return fail("device_offer: pass `baseUrl` (the public https URL of this daemon) or set AGENTPROTO_PUBLIC_HTTP_ORIGIN.")
      }
      let origin: URL
      try {
        origin = new URL(base)
      } catch {
        return fail(`device_offer: "${base}" is not a URL.`)
      }
      if (origin.pathname !== "/" || origin.search || origin.hash) {
        return fail("device_offer: `baseUrl` must be a bare origin (scheme, host, port), without a path.")
      }
      const local = origin.hostname === "127.0.0.1" || origin.hostname === "localhost"
      if (origin.protocol !== "https:" && !local) {
        return fail("device_offer: the daemon's public URL must be https (a connection link must not travel in clear).")
      }
      if (apps !== "*") {
        const missing = apps.filter(id => !opts.appRegistry.getApp(id)?.ui)
        if (missing.length > 0) return fail(`device_offer: not installed, or without a UI: ${missing.join(", ")}.`)
      }
      const offer = getDeviceAccessStore().offer({
        grant: { apps, sessionsRead: sessionsRead === true },
        ...(ttlMinutes !== undefined ? { ttlMs: ttlMinutes * 60_000 } : {}),
        ...(label ? { label } : {}),
      })
      const links = buildPairingLinks({ baseUrl: base, code: offer.code })
      const scope = { apps, sessionsRead: sessionsRead === true }
      if (wanted === "telegram") {
        try {
          await opts.telegram!.send({
            text:
              `Connect a device to ${opts.machineName}.\n\nTap the button on the device you want to connect. ` +
              `It will show a number: compare it with the one in the confirmation message that follows, then confirm.\n\n` +
              `The link works once and expires in ${ttlMinutes ?? 10} minutes.`,
            buttonText: "Connect this device",
            url: links.link,
          })
        } catch (err) {
          return fail(`device_offer: could not send the link: ${err instanceof Error ? err.message : String(err)}`)
        }
        return text({ sent: true, deliver: "telegram", expiresAt: offer.expiresAt, scope })
      }
      return text({ deliver: "return", expiresAt: offer.expiresAt, scope, ...links })
    },
  )

  server.tool(
    "device_pair_pending",
    "List the connection requests waiting for a human confirmation (device name, platform, the number it shows, " +
      "what it asked to open, when it expires). Never returns a secret. It only informs: confirming is done by a " +
      "human on the confirmation channel (the Telegram card or the approval page).",
    {},
    async () => text({ pending: getDeviceAccessStore().pendingRequests() }),
  )
}
