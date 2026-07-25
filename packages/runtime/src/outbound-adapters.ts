/**
 * outbound-adapters — provider-agnostic send for outbound messages.
 * Symmetric to inbound-adapters.ts on the read side.
 *
 * Supports the dialects documented in packages/runtime/docs/TRANSMITTER.md.
 */

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

export interface SendOutboundInput {
  alias?: string
  source: string
  contactRef: string
  text: string
}

export interface SendOutboundDeps {
  mcpProxy: McpProxyRegistry
  telegramCreds?: TelegramBotCredsStore
}

export type SendOutboundResult =
  | { ok: true; providerMessageId?: string }
  | { ok: false; error: string }

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

async function sendAgentpush(
  input: SendOutboundInput,
  deps: SendOutboundDeps,
): Promise<SendOutboundResult> {
  const alias = input.alias
  if (!alias) {
    return { ok: false, error: "missing_alias" }
  }

  const out = await deps.mcpProxy.callTool(alias, "send_message", {
    to: { channel: input.source, address: input.contactRef },
    content: { text: input.text },
  })

  if (!out.ok) {
    return { ok: false, error: out.error }
  }

  // Try to extract a provider message id from the result.
  const providerMessageId = extractProviderMessageId(out.result)
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

  const url = `https://api.telegram.org/bot${tokenRecord.token}/sendMessage`
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: input.contactRef, text: input.text }),
  })

  if (!res.ok) {
    const body = await res.text().catch(() => "")
    return { ok: false, error: `telegram_http_${res.status}: ${body}` }
  }

  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>
  const result =
    typeof json.result === "object" && json.result !== null
      ? (json.result as Record<string, unknown>)
      : undefined
  const providerMessageId =
    typeof result?.message_id === "number"
      ? String(result.message_id)
      : undefined

  return { ok: true, providerMessageId }
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
