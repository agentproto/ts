/**
 * Minimal MCP-transport coverage for `tunnel_list`'s additive limit/cursor
 * pagination (PR-8) — mirrors harness-preset-tools.test.ts's real-McpServer +
 * InMemoryTransport pattern. The registry is seeded through its on-disk
 * persistence file (`loadFromDisk` at construct), so no tunnel provider
 * process is ever spawned.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"

import { registerTunnelTools } from "../tunnel-tools.js"
import { TunnelRegistry } from "../tunnel-registry.js"
import type { RemoteProvider } from "../remote-providers/types.js"

function descriptor(id: string, label: string) {
  return {
    id,
    label,
    provider: "quick",
    targetHost: "127.0.0.1",
    targetPort: 3000,
    publicUrl: `https://${id}.trycloudflare.com`,
    status: "stopped",
    pid: null,
    createdAt: "2026-07-22T10:00:00.000Z",
    stoppedAt: "2026-07-22T11:00:00.000Z",
  }
}

function parse(result: Awaited<ReturnType<Client["callTool"]>>): any {
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content
  const text = content?.find(c => c.type === "text")?.text
  if (!text) throw new Error("tool returned no text content")
  return JSON.parse(text)
}

let home: string
let registry: TunnelRegistry

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "agp-tunnel-tools-"))
  const tunnelsDir = join(home, ".agentproto")
  await mkdir(tunnelsDir, { recursive: true })
  await writeFile(
    join(tunnelsDir, "tunnels.json"),
    JSON.stringify({
      tunnels: [descriptor("t-1", "one"), descriptor("t-2", "two"), descriptor("t-3", "three")],
    }),
    "utf8",
  )
  registry = new TunnelRegistry({ persistPath: join(tunnelsDir, "tunnels.json"), workspace: home })
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

describe("tunnel_list pagination (PR-8)", () => {
  it("page-walk with limit=2 covers exactly the unpaginated list; default call unchanged", async () => {
    const server = new McpServer({ name: "tunnel-tools-test-server", version: "0.0.0" })
    registerTunnelTools(server, { registry })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    const client = new Client({ name: "tunnel-tools-test-client", version: "0.0.0" })
    await client.connect(clientTransport)

    // Default call unchanged: the { tunnels } envelope, no page fields.
    const unpaginated = parse(await client.callTool({ name: "tunnel_list", arguments: {} }))
    expect(unpaginated.tunnels.map((t: { id: string }) => t.id)).toEqual(["t-1", "t-2", "t-3"])
    expect(unpaginated.items).toBeUndefined()
    expect(unpaginated.total).toBeUndefined()

    // Page-walk: the union of pages equals the unpaginated list exactly.
    const union: string[] = []
    let cursor: string | undefined
    do {
      const page = parse(
        await client.callTool({
          name: "tunnel_list",
          arguments: { limit: 2, ...(cursor ? { cursor } : {}) },
        }),
      )
      expect(page.total).toBe(3)
      union.push(...page.items.map((t: { id: string }) => t.id))
      cursor = page.nextCursor
    } while (cursor)
    expect(union).toEqual(["t-1", "t-2", "t-3"])

    await client.close()
  })
})

describe("tunnel_create access guard + tunnel_revoke (P0 signed links)", () => {
  function makeMockProvider(): RemoteProvider {
    return {
      id: "quick",
      async start() {
        return { publicUrl: "https://mock.trycloudflare.com", pid: 4242 }
      },
      async stop() {
        // no-op
      },
    }
  }

  async function makeServerAndClient(home: string) {
    const reg = new (class extends TunnelRegistry {
      protected override async pickProviderForTest(): Promise<RemoteProvider> {
        return makeMockProvider()
      }
    })({ persistPath: join(home, "tunnels.json"), workspace: home })
    const server = new McpServer({ name: "tunnel-tools-guard-test", version: "0.0.0" })
    registerTunnelTools(server, { registry: reg })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    const client = new Client({ name: "tunnel-tools-guard-test-client", version: "0.0.0" })
    await client.connect(clientTransport)
    return { reg, client }
  }

  it("tunnel_create is private by default and returns a token-bearing url", async () => {
    const home2 = await mkdtemp(join(tmpdir(), "agp-tunnel-tools-guard-"))
    try {
      const { client } = await makeServerAndClient(home2)
      const created = parse(
        await client.callTool({ name: "tunnel_create", arguments: { targetPort: 4000 } }),
      )
      expect(created.access).toBe("private")
      expect(created.url).toMatch(/\?t=.+/)
      expect(created.expiresAt).toBeTruthy()
      await client.close()
    } finally {
      await rm(home2, { recursive: true, force: true })
    }
  })

  it("tunnel_revoke mints a fresh url for an active tunnel", async () => {
    const home2 = await mkdtemp(join(tmpdir(), "agp-tunnel-tools-guard-"))
    try {
      const { client } = await makeServerAndClient(home2)
      const created = parse(
        await client.callTool({ name: "tunnel_create", arguments: { targetPort: 4000 } }),
      )
      const revoked = parse(
        await client.callTool({ name: "tunnel_revoke", arguments: { tunnelId: created.id } }),
      )
      expect(revoked.url).not.toBe(created.url)
      expect(revoked.status).toBe("active")
      await client.close()
    } finally {
      await rm(home2, { recursive: true, force: true })
    }
  })

  it("tunnel_revoke errors on a public tunnel", async () => {
    const home2 = await mkdtemp(join(tmpdir(), "agp-tunnel-tools-guard-"))
    try {
      const { client } = await makeServerAndClient(home2)
      const created = parse(
        await client.callTool({
          name: "tunnel_create",
          arguments: { targetPort: 4000, public: true },
        }),
      )
      expect(created.access).toBe("public")
      expect(created.warning).toBeTruthy()
      const result = await client.callTool({
        name: "tunnel_revoke",
        arguments: { tunnelId: created.id },
      })
      expect((result as { isError?: boolean }).isError).toBe(true)
      await client.close()
    } finally {
      await rm(home2, { recursive: true, force: true })
    }
  })
})
