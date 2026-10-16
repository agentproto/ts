/**
 * `app_tunnel` MCP tool — creates an app UI's tunnel through the registry and
 * optionally returns the miniapp session deep link. A mock provider is
 * injected so no cloudflared process is spawned (same pattern as
 * tunnel-tools.test.ts).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"

import { registerAppTunnelTools } from "../app-tunnel-tools.js"
import { TunnelRegistry } from "../tunnel-registry.js"
import type { RemoteProvider } from "../remote-providers/types.js"

function mockProvider(id: string): RemoteProvider {
  return {
    id,
    async start() {
      return { publicUrl: "https://mock.trycloudflare.com", pid: 4242 }
    },
    async stop() {
      // no-op
    },
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
  home = await mkdtemp(join(tmpdir(), "agp-app-tunnel-"))
  registry = new (class extends TunnelRegistry {
    protected override async pickProviderForTest(p: string): Promise<RemoteProvider> {
      return mockProvider(p)
    }
  })({ persistPath: join(home, "tunnels.json"), workspace: home })
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

async function makeClient(
  opts: { readCreds?: (slug: string) => Promise<Record<string, string> | null>; port?: number } = {},
) {
  const server = new McpServer({ name: "app-tunnel-test", version: "0.0.0" })
  registerAppTunnelTools(server, {
    registry,
    ...(opts.readCreds ? { readCreds: opts.readCreds } : {}),
    loadHandle: async () => ({ ui: { ...(opts.port !== undefined ? { port: opts.port } : {}) } }),
  })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: "app-tunnel-test-client", version: "0.0.0" })
  await client.connect(clientTransport)
  return client
}

describe("app_tunnel", () => {
  it("loads ui.port from dir, creates a private quick tunnel, and mints the session link", async () => {
    const client = await makeClient({ port: 4173 })
    const result = parse(
      await client.callTool({ name: "app_tunnel", arguments: { dir: home, session: "sess_9" } }),
    )
    expect(result.targetPort).toBe(4173)
    expect(result.provider).toBe("quick")
    expect(result.url).toMatch(/\?t=.+/)
    const u = new URL(result.url)
    expect(result.sessionLink).toBe(`${u.origin}/s/sess_9?t=${u.searchParams.get("t")}`)
    await client.close()
  })

  it("errors when the app declares no ui.port", async () => {
    const client = await makeClient()
    const res = await client.callTool({ name: "app_tunnel", arguments: { dir: home } })
    expect((res as { isError?: boolean }).isError).toBe(true)
    expect((res as { content: { text: string }[] }).content[0]!.text).toMatch(/ui\.port/)
    await client.close()
  })

  it("uses cloudflare-named + registered creds when hostname is given", async () => {
    const client = await makeClient({
      readCreds: async slug => (slug === "cloudflare-named" ? { tunnelId: "tid", credentialsFile: "/c.json" } : null),
    })
    const result = parse(
      await client.callTool({
        name: "app_tunnel",
        arguments: { targetPort: 4173, hostname: "app.example.com" },
      }),
    )
    expect(result.provider).toBe("cloudflare-named")
    expect(result.hostname).toBe("app.example.com")
    expect(result.sessionLink).toBeUndefined()
    await client.close()
  })

  it("errors on hostname when named creds are not registered", async () => {
    const client = await makeClient({ readCreds: async () => null })
    const res = await client.callTool({
      name: "app_tunnel",
      arguments: { targetPort: 4173, hostname: "app.example.com" },
    })
    expect((res as { isError?: boolean }).isError).toBe(true)
    expect((res as { content: { text: string }[] }).content[0]!.text).toMatch(/registered credentials/)
    await client.close()
  })

  it("requires a targetPort or a dir", async () => {
    const client = await makeClient()
    const res = await client.callTool({ name: "app_tunnel", arguments: {} })
    expect((res as { isError?: boolean }).isError).toBe(true)
    await client.close()
  })
})
