import { describe, it, expect, vi } from "vitest"
import { sendOutbound } from "../outbound-adapters.js"
import type { McpProxyRegistry, ProxyCallOutcome } from "../mcp-proxy.js"
import type { TelegramBotCredsStore } from "../telegram-bot-creds.js"

function makeMockTelegramCreds(
  readValue: { token: string } | null,
): TelegramBotCredsStore {
  return {
    read: vi.fn().mockResolvedValue(readValue),
    write: vi.fn(),
    exists: vi.fn().mockResolvedValue(readValue !== null),
  }
}

describe("sendOutbound", () => {
  it("agentpush calls send_message and returns providerMessageId", async () => {
    const callTool = vi.fn(
      async (): Promise<ProxyCallOutcome> => ({
        ok: true,
        result: { messageId: "msg-123" },
      }),
    )
    const mcpProxy = { callTool } as unknown as McpProxyRegistry

    const result = await sendOutbound(
      "agentpush",
      { alias: "agentpush", source: "+33600000000", contactRef: "alice", text: "hello" },
      { mcpProxy },
    )

    expect(callTool).toHaveBeenCalledWith("agentpush", "send_message", {
      to: { channel: "+33600000000", address: "alice" },
      content: { text: "hello" },
    })
    expect(result).toEqual({ ok: true, providerMessageId: "msg-123" })
  })

  it("agentpush returns error when alias is missing", async () => {
    const mcpProxy = { callTool: vi.fn() } as unknown as McpProxyRegistry

    const result = await sendOutbound(
      "agentpush",
      { source: "+33600000000", contactRef: "alice", text: "hello" },
      { mcpProxy },
    )

    expect(result).toEqual({ ok: false, error: "missing_alias" })
    expect(mcpProxy.callTool).not.toHaveBeenCalled()
  })

  it("telegram sends via Bot API and returns providerMessageId from message_id", async () => {
    const globalFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, result: { message_id: 42 } }),
    } as unknown as Response)
    vi.stubGlobal("fetch", globalFetch)

    const telegramCreds = makeMockTelegramCreds({ token: "bot-token-123" })
    const mcpProxy = { callTool: vi.fn() } as unknown as McpProxyRegistry

    const result = await sendOutbound(
      "telegram",
      { alias: "mybot", source: "telegram", contactRef: "987654321", text: "hi" },
      { mcpProxy, telegramCreds },
    )

    expect(telegramCreds.read).toHaveBeenCalledWith("mybot")
    expect(globalFetch).toHaveBeenCalledWith(
      "https://api.telegram.org/botbot-token-123/sendMessage",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // chat_id MUST come from contactRef (the real chat id), never from
        // source (just the channel name "telegram") — distinct values here
        // so a source/contactRef mix-up fails this assertion.
        body: JSON.stringify({ chat_id: "987654321", text: "hi" }),
      },
    )
    expect(result).toEqual({ ok: true, providerMessageId: "42" })

    vi.unstubAllGlobals()
  })

  it("telegram returns error when telegramCreds is missing", async () => {
    const mcpProxy = { callTool: vi.fn() } as unknown as McpProxyRegistry

    const result = await sendOutbound(
      "telegram",
      { source: "123", contactRef: "123", text: "hi" },
      { mcpProxy },
    )

    expect(result).toEqual({ ok: false, error: "telegram_creds_not_configured" })
  })

  it("telegram returns error when token not found", async () => {
    const telegramCreds = makeMockTelegramCreds(null)
    const mcpProxy = { callTool: vi.fn() } as unknown as McpProxyRegistry

    const result = await sendOutbound(
      "telegram",
      { alias: "missing", source: "123", contactRef: "123", text: "hi" },
      { mcpProxy, telegramCreds },
    )

    expect(result).toEqual({ ok: false, error: "telegram_token_not_found_for_alias_missing" })
  })

  it("telegram returns error on HTTP failure", async () => {
    const globalFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      text: async () => "Forbidden",
    } as unknown as Response)
    vi.stubGlobal("fetch", globalFetch)

    const telegramCreds = makeMockTelegramCreds({ token: "bad-token" })
    const mcpProxy = { callTool: vi.fn() } as unknown as McpProxyRegistry

    const result = await sendOutbound(
      "telegram",
      { source: "123", contactRef: "123", text: "hi" },
      { mcpProxy, telegramCreds },
    )

    expect(result.ok).toBe(false)
    expect((result as { ok: false; error: string }).error).toContain("telegram_http_403")

    vi.unstubAllGlobals()
  })

  it.each(["whatsapp", "slack", "generic", "native"] as const)(
    "%s returns unsupported_provider error",
    async provider => {
      const mcpProxy = { callTool: vi.fn() } as unknown as McpProxyRegistry

      const result = await sendOutbound(
        provider,
        { source: "s", contactRef: "c", text: "hi" },
        { mcpProxy },
      )

      expect(result).toEqual({ ok: false, error: "unsupported_provider" })
    },
  )
})
