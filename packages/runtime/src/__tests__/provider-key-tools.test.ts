/**
 * `provider_key_list` — the legacy `~/.agentproto/providers.json` key store
 * read via a fake HOME (never the real file/keychain, per repo policy) and a
 * fake `env` object passed straight into `buildProviderKeyRows` (unit tests)
 * or `registerProviderKeyTools`'s `env` option (MCP-transport test), so
 * nothing here ever reads the real ambient shell environment.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { setProviderKey } from "@agentproto/providers-store"

import { buildProviderKeyRows, registerProviderKeyTools } from "../provider-key-tools.js"

function parse(result: Awaited<ReturnType<Client["callTool"]>>): any {
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content
  const text = content?.find(c => c.type === "text")?.text
  if (!text) throw new Error("tool returned no text content")
  return JSON.parse(text)
}

let prevHome: string | undefined
let home: string

beforeEach(async () => {
  prevHome = process.env.HOME
  home = await mkdtemp(join(tmpdir(), "agp-provider-key-tools-"))
  process.env.HOME = home
})

afterEach(async () => {
  if (prevHome === undefined) delete process.env.HOME
  else process.env.HOME = prevHome
  await rm(home, { recursive: true, force: true })
})

describe("buildProviderKeyRows", () => {
  it("file-only: row reports source file, not shadowed", async () => {
    await setProviderKey("anthropic", "sk-ant-file0000aaaa")
    const rows = await buildProviderKeyRows({})
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      provider: "anthropic",
      envVar: "ANTHROPIC_API_KEY",
      set: true,
      source: "file",
      shadowedByEnv: false,
    })
    expect(rows[0]?.fingerprint).toBeTruthy()
    expect(rows[0]?.last4).toBe("aaaa")
  })

  it("env-only: known provider with no file entry gets an env row", async () => {
    const rows = await buildProviderKeyRows({ OPENROUTER_API_KEY: "sk-or-env0000bbbb" })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      provider: "openrouter",
      envVar: "OPENROUTER_API_KEY",
      set: true,
      source: "env",
      shadowedByEnv: false,
    })
    expect(rows[0]?.last4).toBe("bbbb")
  })

  it("both-equal: env holds the SAME value as the file — not shadowed (boot-injected)", async () => {
    const key = "sk-openai-same0000cccc"
    await setProviderKey("openai", key)
    const rows = await buildProviderKeyRows({ OPENAI_API_KEY: key })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      provider: "openai",
      source: "file+env",
      shadowedByEnv: false,
    })
  })

  it("both-different: env holds a DIFFERENT value than the file — shadowed", async () => {
    await setProviderKey("mistral", "sk-mistral-file0000dddd")
    const rows = await buildProviderKeyRows({ MISTRAL_API_KEY: "sk-mistral-explicit0000eeee" })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      provider: "mistral",
      source: "file+env",
      shadowedByEnv: true,
    })
  })

  it("empty/missing file and no matching env: no rows", async () => {
    const rows = await buildProviderKeyRows({})
    expect(rows).toEqual([])
  })

  it("baseUrl from the file entry rides along on a file row", async () => {
    await setProviderKey("openrouter", "sk-or-base0000ffff", "https://example.test/v1")
    const rows = await buildProviderKeyRows({})
    expect(rows[0]?.baseUrl).toBe("https://example.test/v1")
  })

  it("provider absent from providers.json and unknown to PROVIDER_ENV_VARS is ignored", async () => {
    // Only known providers get an env-only row; an unset, unknown provider
    // env var is simply not a row at all.
    const rows = await buildProviderKeyRows({ SOME_RANDOM_TOOL_API_KEY: "not-a-provider-key" })
    expect(rows).toEqual([])
  })
})

describe("provider_key_list MCP tool", () => {
  const SECRETS = [
    "sk-ant-mcp-secret-11112222",
    "sk-openrouter-mcp-secret-33334444",
  ] as const

  async function setup(env: NodeJS.ProcessEnv) {
    const server = new McpServer({ name: "provider-key-tools-test-server", version: "0.0.0" })
    registerProviderKeyTools(server, { env })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    const client = new Client({ name: "provider-key-tools-test-client", version: "0.0.0" })
    await client.connect(clientTransport)
    return { client, close: () => client.close() }
  }

  it("never serializes a raw key, and filters by provider", async () => {
    await setProviderKey("anthropic", SECRETS[0])
    const { client, close } = await setup({ OPENROUTER_API_KEY: SECRETS[1] })
    try {
      const raw = await client.callTool({ name: "provider_key_list", arguments: {} })
      const serialized = JSON.stringify(raw)
      for (const secret of SECRETS) {
        expect(serialized).not.toContain(secret)
      }
      const result = parse(raw)
      expect(result.providers.map((p: { provider: string }) => p.provider).sort()).toEqual([
        "anthropic",
        "openrouter",
      ])

      const filtered = parse(
        await client.callTool({ name: "provider_key_list", arguments: { provider: "anthropic" } }),
      )
      expect(filtered.providers).toHaveLength(1)
      expect(filtered.providers[0].provider).toBe("anthropic")
      expect(filtered.providers[0].source).toBe("file")
    } finally {
      await close()
    }
  })
})
