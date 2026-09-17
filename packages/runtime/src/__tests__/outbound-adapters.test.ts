import { describe, it, expect, vi, beforeEach } from "vitest"
import { sendOutbound, toFetchBody } from "../outbound-adapters.js"
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

/** Wraps a payload the way a real MCP `tools/call` result does — a JSON text
 *  content block, no `structuredContent` — matching what agentpush's server
 *  actually returns (confirmed against the live `send_message` response). */
function mcpTextResult(payload: unknown): ProxyCallOutcome {
  return { ok: true, result: { content: [{ type: "text", text: JSON.stringify(payload) }] } }
}

describe("sendOutbound", () => {
  it("agentpush calls send_message and returns providerMessageId from a sent status", async () => {
    const callTool = vi.fn(
      async (): Promise<ProxyCallOutcome> =>
        mcpTextResult({ status: "sent", message_id: "msg-123" }),
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

  it("agentpush surfaces a blocked status as a failure with blocked_reason/suggestion, not sent:true", async () => {
    // The exact body agentpush returned (HTTP 200) for a WhatsApp send outside
    // the 24h session window — proven in prod 2026-09-17.
    const callTool = vi.fn(
      async (): Promise<ProxyCallOutcome> =>
        mcpTextResult({
          status: "blocked",
          blocked_reason: "session_expired",
          suggestion:
            "La fenêtre de session WhatsApp 24h est expirée ou absente. Utilisez un template approuvé pour initier la conversation.",
        }),
    )
    const mcpProxy = { callTool } as unknown as McpProxyRegistry

    const result = await sendOutbound(
      "agentpush",
      { alias: "agentpush-prod", source: "whatsapp", contactRef: "+33679942048", text: "hello" },
      { mcpProxy },
    )

    expect(result).toEqual({
      ok: false,
      error: "session_expired",
      blockedReason: "session_expired",
      suggestion:
        "La fenêtre de session WhatsApp 24h est expirée ou absente. Utilisez un template approuvé pour initier la conversation.",
    })
  })

  it("agentpush surfaces a failed status as a failure, not sent:true", async () => {
    const callTool = vi.fn(
      async (): Promise<ProxyCallOutcome> =>
        mcpTextResult({ status: "failed", error: "provider_rejected" }),
    )
    const mcpProxy = { callTool } as unknown as McpProxyRegistry

    const result = await sendOutbound(
      "agentpush",
      { alias: "agentpush", source: "whatsapp", contactRef: "alice", text: "hello" },
      { mcpProxy },
    )

    expect(result).toEqual({ ok: false, error: "provider_rejected" })
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

  it("telegram returns error when the API replies HTTP 200 with ok:false", async () => {
    // Telegram's own docs: for backward compatibility some errors are
    // returned with HTTP 200 and `ok: false` in the body rather than a
    // non-2xx status — the same false-positive class as agentpush's
    // `status: "blocked"`. A 200 alone must not be read as sent:true.
    const globalFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: false, error_code: 400, description: "Bad Request: chat not found" }),
    } as unknown as Response)
    vi.stubGlobal("fetch", globalFetch)

    const telegramCreds = makeMockTelegramCreds({ token: "bot-token-123" })
    const mcpProxy = { callTool: vi.fn() } as unknown as McpProxyRegistry

    const result = await sendOutbound(
      "telegram",
      { alias: "mybot", source: "telegram", contactRef: "000", text: "hi" },
      { mcpProxy, telegramCreds },
    )

    expect(result.ok).toBe(false)
    expect((result as { ok: false; error: string }).error).toContain("Bad Request: chat not found")

    vi.unstubAllGlobals()
  })

  it("agentpush uploads local attachments and sends media", async () => {
    const mockedReadFile = vi.mocked(readFile)
    mockedReadFile.mockResolvedValue(Buffer.from("fake-image-bytes"))

    const callTool = vi.fn(
      async (_alias: string, tool: string): Promise<ProxyCallOutcome> => {
        if (tool === "upload_media") {
          return mcpTextResult({ media_id: "media-123", url: "https://example.com/media" })
        }
        if (tool === "send_message") {
          return mcpTextResult({ status: "sent", message_id: "msg-456" })
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
      body: Uint8Array
    }
    expect(init.body).toBeInstanceOf(Uint8Array)
    const bodyText = Buffer.from(init.body).toString()
    expect(bodyText).toContain("Content-Disposition: form-data")
    expect(bodyText).toContain("fake-image-bytes")
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
    const groupInit = globalFetch.mock.calls[0]![1] as {
      headers: Record<string, string>
      body: Uint8Array
    }
    expect(groupInit.body).toBeInstanceOf(Uint8Array)
    const groupBodyText = Buffer.from(groupInit.body).toString()
    expect(groupBodyText).toContain("Content-Disposition: form-data")
    expect(groupBodyText).toContain("img1")
    expect(groupBodyText).toContain("img2")
    expect(groupBodyText).toContain('"media":"attach://file0"')
    expect(groupBodyText).toContain('"media":"attach://file1"')
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

  describe("toFetchBody", () => {
    it("returns a Uint8Array backed by an ArrayBuffer with identical bytes", () => {
      const bytes = Buffer.from([0x00, 0x01, 0xff, 0x80])
      const body = toFetchBody(bytes)

      expect(body).toBeInstanceOf(Uint8Array)
      expect(body.buffer).toBeInstanceOf(ArrayBuffer)
      expect(Buffer.from(body).equals(bytes)).toBe(true)
      expect(Array.from(body)).toEqual([0, 1, 255, 128])
    })

    it("preserves non-ASCII bytes including UTF-8 sequences", () => {
      const text = "héllo 🌍"
      const bytes = Buffer.from(text, "utf8")
      const body = toFetchBody(bytes)

      expect(Buffer.from(body).toString("utf8")).toBe(text)
    })
  })
})
