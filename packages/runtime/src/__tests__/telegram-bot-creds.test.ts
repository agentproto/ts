/**
 * Tests for telegram-bot-creds.ts store + MCP tools.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"

import {
  makeTelegramBotCredsStore,
  registerTelegramBotTools,
} from "../telegram-bot-creds.js"

function textOf(res: { content?: Array<{ type: string; text?: string }>; isError?: boolean }): string {
  return res.content?.find(c => c.type === "text")?.text ?? ""
}

async function connectTools(telegramCreds: ReturnType<typeof makeTelegramBotCredsStore>): Promise<Client> {
  const server = new McpServer({ name: "telegram-bot-test-server", version: "0.0.0" })
  registerTelegramBotTools(server, { telegramCreds })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: "telegram-bot-test-client", version: "0.0.0" })
  await client.connect(clientTransport)
  return client
}

describe("makeTelegramBotCredsStore", () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "telegram-bot-creds-test-"))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it("round-trips a token and reports exists", async () => {
    const store = makeTelegramBotCredsStore(dir)
    await store.write("default", { token: "secret-token" })
    expect(await store.exists("default")).toBe(true)
    const read = await store.read("default")
    expect(read?.token).toBe("secret-token")
  })

  it("returns null and false for missing alias", async () => {
    const store = makeTelegramBotCredsStore(dir)
    expect(await store.exists("missing")).toBe(false)
    expect(await store.read("missing")).toBeNull()
  })
})

describe("telegram_bot_token_set / telegram_bot_token_status", () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "telegram-bot-tools-test-"))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it("stores a token and returns fingerprint without echoing the token", async () => {
    const store = makeTelegramBotCredsStore(dir)
    const client = await connectTools(store)

    const res = (await client.callTool({
      name: "telegram_bot_token_set",
      arguments: { token: "my-secret-bot-token" },
    })) as { content: Array<{ type: string; text?: string }> }

    const parsed = JSON.parse(textOf(res))
    expect(parsed.ok).toBe(true)
    expect(parsed.alias).toBe("default")
    expect(parsed.fingerprint).toBeDefined()
    expect(parsed.token).toBeUndefined()

    const stored = await store.read("default")
    expect(stored?.token).toBe("my-secret-bot-token")
  })

  it("status reports configured false when token missing", async () => {
    const store = makeTelegramBotCredsStore(dir)
    const client = await connectTools(store)

    const res = (await client.callTool({
      name: "telegram_bot_token_status",
      arguments: { alias: "other" },
    })) as { content: Array<{ type: string; text?: string }> }

    const parsed = JSON.parse(textOf(res))
    expect(parsed.configured).toBe(false)
    expect(parsed.token).toBeUndefined()
  })

  it("status reports configured true and identity after token set", async () => {
    const store = makeTelegramBotCredsStore(dir)
    const client = await connectTools(store)

    await client.callTool({
      name: "telegram_bot_token_set",
      arguments: { token: "another-secret", alias: "secondary" },
    })

    const res = (await client.callTool({
      name: "telegram_bot_token_status",
      arguments: { alias: "secondary" },
    })) as { content: Array<{ type: string; text?: string }> }

    const parsed = JSON.parse(textOf(res))
    expect(parsed.configured).toBe(true)
    expect(parsed.fingerprint).toBeDefined()
    expect(parsed.token).toBeUndefined()
  })
})

describe("telegram_bot_set_webhook", () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "telegram-bot-webhook-test-"))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it("returns error when token is not configured", async () => {
    const store = makeTelegramBotCredsStore(dir)
    const client = await connectTools(store)

    const res = (await client.callTool({
      name: "telegram_bot_set_webhook",
      arguments: { url: "https://example.com/inbound/x" },
    })) as { content: Array<{ type: string; text?: string }>; isError?: boolean }

    expect(res.isError).toBe(true)
    const parsed = JSON.parse(textOf(res))
    expect(parsed.error).toBe("telegram_token_not_configured")
  })

  it("calls Telegram setWebhook when token is configured", async () => {
    const store = makeTelegramBotCredsStore(dir)
    await store.write("default", { token: "bot-token" })

    const globalFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, result: true }),
    } as unknown as Response)
    vi.stubGlobal("fetch", globalFetch)

    const client = await connectTools(store)

    try {
      const res = (await client.callTool({
        name: "telegram_bot_set_webhook",
        arguments: { url: "https://example.com/inbound/x", secret_token: "my-secret" },
      })) as { content: Array<{ type: string; text?: string }> }

      const parsed = JSON.parse(textOf(res))
      expect(parsed.ok).toBe(true)
      expect(parsed.url).toBe("https://example.com/inbound/x")
      expect(parsed.secret_token).toBe("my-secret")

      expect(globalFetch).toHaveBeenCalledWith(
        "https://api.telegram.org/botbot-token/setWebhook",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ url: "https://example.com/inbound/x", secret_token: "my-secret" }),
        }),
      )
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
