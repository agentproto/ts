import { describe, it, expect, vi, beforeEach } from "vitest"
import { sendOutbound } from "../outbound-adapters.js"
import type { McpProxyRegistry, ProxyCallOutcome } from "../mcp-proxy.js"
import type { TelegramBotCredsStore } from "../telegram-bot-creds.js"
import { readFile } from "node:fs/promises"

vi.mock("node:fs/promises", () => ({ readFile: vi.fn() }))

function makeMockTelegramCreds(
  readValue: { token: string } | null,
): TelegramBotCredsStore {
  return {
    read: vi.fn().mockResolvedValue(readValue),
    write: vi.fn(),
    exists: vi.fn().mockResolvedValue(readValue !== null),
  }
}

beforeEach(() => {
  vi.mocked(readFile).mockReset()
})

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
        body: JSON.stringify({
          chat_id: "987654321",
          text: "hi",
          parse_mode: "MarkdownV2",
        }),
      },
    )
    expect(result).toEqual({ ok: true, providerMessageId: "42" })

    vi.unstubAllGlobals()
  })

  it("telegram converts markdown to MarkdownV2 for sendMessage", async () => {
    const globalFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, result: { message_id: 7 } }),
    } as unknown as Response)
    vi.stubGlobal("fetch", globalFetch)

    const telegramCreds = makeMockTelegramCreds({ token: "bot-token-123" })
    const mcpProxy = { callTool: vi.fn() } as unknown as McpProxyRegistry

    await sendOutbound(
      "telegram",
      { alias: "mybot", source: "telegram", contactRef: "987654321", text: "hello **world** and _agent_" },
      { mcpProxy, telegramCreds },
    )

    const body = (globalFetch.mock.calls[0]![1] as { body: string }).body
    expect(JSON.parse(body)).toEqual({
      chat_id: "987654321",
      text: "hello *world* and _agent_",
      parse_mode: "MarkdownV2",
    })

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

  it("agentpush uploads local attachments and sends media", async () => {
    const mockedReadFile = vi.mocked(readFile)
    mockedReadFile.mockResolvedValue(Buffer.from("fake-image-bytes"))

    const callTool = vi.fn(
      async (_alias: string, tool: string): Promise<ProxyCallOutcome> => {
        if (tool === "upload_media") {
          return { ok: true, result: { media_id: "media-123", url: "https://example.com/media" } }
        }
        if (tool === "send_message") {
          return { ok: true, result: { messageId: "msg-456" } }
        }
        return { ok: false, error: "unexpected tool" }
      },
    )
    const mcpProxy = { callTool } as unknown as McpProxyRegistry

    const result = await sendOutbound(
      "agentpush",
      {
        alias: "agentpush",
        source: "telegram",
        contactRef: "alice",
        text: "see attached",
        attachments: [{ type: "photo", path: "/tmp/photo.jpg", caption: "my photo" }],
      },
      { mcpProxy },
    )

    expect(result).toEqual({ ok: true, providerMessageId: "msg-456" })
    expect(callTool).toHaveBeenCalledWith("agentpush", "upload_media", {
      channel: "telegram",
      type: "image",
      data: Buffer.from("fake-image-bytes").toString("base64"),
      filename: "photo.jpg",
      mimeType: "image/jpeg",
    })
    expect(callTool).toHaveBeenCalledWith("agentpush", "send_message", {
      to: { channel: "telegram", address: "alice" },
      content: {
        text: "see attached",
        media: [
          {
            type: "image",
            providerMediaId: "media-123",
            filename: "photo.jpg",
            mimeType: "image/jpeg",
            caption: "my photo",
          },
        ],
      },
    })
  })

  it("telegram sends a local photo via sendPhoto multipart", async () => {
    const mockedReadFile = vi.mocked(readFile)
    mockedReadFile.mockResolvedValue(Buffer.from("fake-image-bytes"))

    const globalFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, result: { message_id: 77 } }),
    } as unknown as Response)
    vi.stubGlobal("fetch", globalFetch)

    const telegramCreds = makeMockTelegramCreds({ token: "bot-token-123" })
    const mcpProxy = { callTool: vi.fn() } as unknown as McpProxyRegistry

    const result = await sendOutbound(
      "telegram",
      {
        alias: "mybot",
        source: "telegram",
        contactRef: "987654321",
        text: "hi",
        attachments: [{ type: "photo", path: "/tmp/photo.png" }],
      },
      { mcpProxy, telegramCreds },
    )

    expect(telegramCreds.read).toHaveBeenCalledWith("mybot")
    expect(globalFetch).toHaveBeenCalledWith(
      "https://api.telegram.org/botbot-token-123/sendPhoto",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "Content-Type": expect.stringContaining("multipart/form-data"),
        }),
      }),
    )
    const init = globalFetch.mock.calls[0]![1] as {
      headers: Record<string, string>
      body: Buffer
    }
    expect(init.body.toString()).toContain("Content-Disposition: form-data")
    expect(init.body.toString()).toContain("fake-image-bytes")
    expect(result).toEqual({ ok: true, providerMessageId: "77" })

    vi.unstubAllGlobals()
  })

  it("telegram sends multiple attachments via sendMediaGroup", async () => {
    const mockedReadFile = vi.mocked(readFile)
    mockedReadFile
      .mockResolvedValueOnce(Buffer.from("img1"))
      .mockResolvedValueOnce(Buffer.from("img2"))

    const globalFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, result: [{ message_id: 10 }, { message_id: 11 }] }),
    } as unknown as Response)
    vi.stubGlobal("fetch", globalFetch)

    const telegramCreds = makeMockTelegramCreds({ token: "token" })
    const result = await sendOutbound(
      "telegram",
      {
        alias: "default",
        source: "telegram",
        contactRef: "123",
        text: "album",
        attachments: [
          { type: "photo", path: "/tmp/a.jpg" },
          { type: "video", path: "/tmp/b.mp4", caption: "vid" },
        ],
      },
      { mcpProxy: { callTool: vi.fn() } as unknown as McpProxyRegistry, telegramCreds },
    )

    expect(globalFetch).toHaveBeenCalledWith(
      "https://api.telegram.org/bottoken/sendMediaGroup",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "Content-Type": expect.stringContaining("multipart/form-data"),
        }),
      }),
    )
    expect(result).toEqual({ ok: true, providerMessageId: "10" })

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
