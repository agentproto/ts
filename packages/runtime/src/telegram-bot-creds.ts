/**
 * Telegram bot credential store + MCP tools.
 *
 * Uses @agentproto/provider-kit's makeCredsStore so tokens live at
 * ~/.agentproto/telegram-bot-creds/<alias>.json with mode 0600. The value
 * is never echoed by any tool; status reads only report whether a token
 * exists and a one-way fingerprint/last4 identity.
 */

import { createHash, randomBytes } from "node:crypto"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import { makeCredsStore } from "@agentproto/provider-kit"

export interface TelegramBotCreds {
  token: string
}

export interface TelegramBotCredsStore {
  read(alias: string): Promise<TelegramBotCreds | null>
  write(alias: string, creds: TelegramBotCreds): Promise<void>
  exists(alias: string): Promise<boolean>
}

export const TELEGRAM_BOT_CREDS_FAMILY = "telegram-bot"

export function makeTelegramBotCredsStore(home?: string): TelegramBotCredsStore {
  const store = makeCredsStore<TelegramBotCreds>({
    family: TELEGRAM_BOT_CREDS_FAMILY,
    ...(home ? { home } : {}),
  })
  return {
    read: alias => store.read(alias),
    write: (alias, creds) => store.write(alias, creds),
    exists: alias => store.exists(alias),
  }
}

function credentialIdentity(value: string): { fingerprint: string; last4?: string } {
  const hash = createHash("sha256").update(value, "utf8").digest("hex")
  const fingerprint = hash.slice(0, 16)
  const last4 = value.length >= 4 ? value.slice(-4) : undefined
  return { fingerprint, last4 }
}

export interface RegisterTelegramBotToolsOptions {
  telegramCreds: TelegramBotCredsStore
}

export function registerTelegramBotTools(server: McpServer, opts: RegisterTelegramBotToolsOptions): void {
  const { telegramCreds } = opts

  server.tool(
    "telegram_bot_token_set",
    "Store or rotate a Telegram bot token. The token is written to a 0600 " +
      "file under ~/.agentproto/telegram-bot-creds/ and is never returned. " +
      "Use alias \"default\" for the primary bot, or a custom alias for " +
      "multiple bots.",
    {
      token: z
        .string()
        .min(1)
        .describe("The Telegram bot token from @BotFather. Stored, never echoed."),
      alias: z
        .string()
        .optional()
        .describe('Bot alias; default "default".'),
    },
    async ({ token, alias }) => {
      const botAlias = alias ?? "default"
      await telegramCreds.write(botAlias, { token })
      const identity = credentialIdentity(token)
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                ok: true,
                alias: botAlias,
                fingerprint: identity.fingerprint,
                ...(identity.last4 ? { last4: identity.last4 } : {}),
              },
              null,
              2,
            ),
          },
        ],
      }
    },
  )

  server.tool(
    "telegram_bot_token_status",
    "Check whether a Telegram bot token is stored. Never returns the token; " +
      "only non-secret metadata (fingerprint, last4) so you can confirm which " +
      "secret is loaded.",
    {
      alias: z
        .string()
        .optional()
        .describe('Bot alias; default "default".'),
    },
    async ({ alias }) => {
      const botAlias = alias ?? "default"
      const creds = await telegramCreds.read(botAlias)
      if (!creds || !creds.token) {
        return {
          content: [{ type: "text", text: JSON.stringify({ alias: botAlias, configured: false }, null, 2) }],
        }
      }
      const identity = credentialIdentity(creds.token)
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                alias: botAlias,
                configured: true,
                fingerprint: identity.fingerprint,
                ...(identity.last4 ? { last4: identity.last4 } : {}),
              },
              null,
              2,
            ),
          },
        ],
      }
    },
  )

  server.tool(
    "telegram_bot_set_webhook",
    "Call Telegram's setWebhook endpoint for a bot alias. Requires the token " +
      "to be configured with telegram_bot_token_set. Uses the configured " +
      "token; the secret_token is generated if omitted.",
    {
      alias: z
        .string()
        .optional()
        .describe('Bot alias; default "default".'),
      url: z
        .string()
        .url()
        .describe("Public HTTPS webhook URL (e.g. from cloudflared)."),
      secret_token: z
        .string()
        .min(1)
        .optional()
        .describe("Value for Telegram's secret_token webhook header. Generated if omitted."),
    },
    async ({ alias, url, secret_token }) => {
      const botAlias = alias ?? "default"
      const creds = await telegramCreds.read(botAlias)
      if (!creds || !creds.token) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                { ok: false, alias: botAlias, error: "telegram_token_not_configured" },
                null,
                2,
              ),
            },
          ],
          isError: true,
        }
      }

      const token = creds.token
      const generatedSecret = secret_token ?? randomBytes(32).toString("hex")
      const setUrl = `https://api.telegram.org/bot${token}/setWebhook`

      try {
        const res = await fetch(setUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url, secret_token: generatedSecret }),
        })
        const body = (await res.json().catch(() => ({}))) as Record<string, unknown>

        if (!res.ok || body.ok !== true) {
          const description = typeof body.description === "string" ? body.description : "unknown error"
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  { ok: false, alias: botAlias, telegram_error: description },
                  null,
                  2,
                ),
              },
            ],
            isError: true,
          }
        }

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  ok: true,
                  alias: botAlias,
                  url,
                  secret_token: generatedSecret,
                },
                null,
                2,
              ),
            },
          ],
        }
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  ok: false,
                  alias: botAlias,
                  error: err instanceof Error ? err.message : String(err),
                },
                null,
                2,
              ),
            },
          ],
          isError: true,
        }
      }
    },
  )
}
