/**
 * Unit coverage for `computeCapabilitiesInventory` (capabilities-inventory.ts)
 * — the shared builder behind the `capabilities_inventory` MCP tool and its
 * `GET /capabilities/inventory` HTTP twin. Exercises the `mcp` block only
 * (imported/discovered projection, `usedBySessions`, redaction) plus the
 * "one block fails, the other still returns" contract — the `skills` block's
 * adapter-package introspection is covered by not wiring `listAgentAdapters`
 * at all (empty `byHarness`, defaults still read from the injected config).
 */

import { describe, it, expect } from "vitest"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { createMcpServer } from "@agentproto/mcp-server"
import { registerSessionTools } from "../session-tools.js"
import { createSessionsRegistry, type SessionsRegistry } from "../sessions.js"
import type { McpProxyRegistry, ProxyAliasSummary } from "../mcp-proxy.js"
import type { ImportedMcpsConfig } from "../mcp-imports.js"
import type { DiscoveredMcp } from "../mcp-discovery.js"
import { computeCapabilitiesInventory, computeImportedReach } from "../capabilities-inventory.js"

const IMPORTED_SNAPSHOT: DiscoveredMcp = {
  id: "claude-code:global:chrome-devtools",
  source: "claude-code",
  scope: "global",
  name: "chrome-devtools",
  type: "stdio",
  command: "npx",
  args: ["-y", "chrome-devtools-mcp"],
  env: { SECRET_TOKEN: "shh" },
}

const IMPORTED_CONFIG: ImportedMcpsConfig = {
  version: 1,
  imports: [
    {
      id: IMPORTED_SNAPSHOT.id,
      alias: "chrome-devtools",
      addedAt: "2026-01-01T00:00:00.000Z",
      snapshot: IMPORTED_SNAPSHOT,
    },
  ],
}

const DISCOVERED_ONLY: DiscoveredMcp = {
  id: "cursor:global:goose-bridge",
  source: "cursor",
  scope: "global",
  name: "goose-bridge",
  type: "http",
  url: "https://example.internal/mcp",
  headers: { Authorization: "Bearer shh" },
}

function fakeRegistry(sessions: Array<{ id: string; status: string; mcpServers?: unknown[] }>): SessionsRegistry {
  return {
    list: () => sessions as never,
  } as unknown as SessionsRegistry
}

function fakeProxy(aliases: ProxyAliasSummary[]): McpProxyRegistry {
  return { listAliases: async () => aliases } as unknown as McpProxyRegistry
}

describe("computeCapabilitiesInventory", () => {
  it("projects one connected imported MCP and one discovered-only MCP, with usedBySessions and full redaction", async () => {
    const registry = fakeRegistry([
      {
        id: "sess-1",
        status: "running",
        mcpServers: [{ name: "chrome-devtools", transport: "stdio" }],
      },
      { id: "sess-2", status: "running", mcpServers: [] },
    ])
    const mcpProxy = fakeProxy([
      {
        alias: "chrome-devtools",
        importId: IMPORTED_SNAPSHOT.id,
        source: "claude-code",
        type: "stdio",
        status: "connected",
        toolCount: 7,
      },
    ])

    const inventory = await computeCapabilitiesInventory({
      registry,
      mcpProxy,
      loadImportedMcps: async () => IMPORTED_CONFIG,
      discoverMcps: async () => [IMPORTED_SNAPSHOT, DISCOVERED_ONLY],
      loadConfig: async () => ({}),
    })

    expect(inventory.mcp.error).toBeUndefined()
    expect(inventory.mcp.imported).toEqual([
      {
        id: IMPORTED_SNAPSHOT.id,
        name: "chrome-devtools",
        type: "stdio",
        source: "claude-code",
        status: "connected",
        toolCount: 7,
        usedBySessions: ["sess-1"],
        reach: {},
      },
    ])

    const discoveredById = new Map(inventory.mcp.discovered.map(d => [d.id, d]))
    expect(discoveredById.get(IMPORTED_SNAPSHOT.id)?.imported).toBe(true)
    expect(discoveredById.get(DISCOVERED_ONLY.id)?.imported).toBe(false)

    // Redaction: nothing in the payload ever carries command/args/env/url/headers.
    const serialized = JSON.stringify(inventory)
    expect(serialized).not.toContain("shh")
    expect(serialized).not.toContain("npx")
    expect(serialized).not.toContain("chrome-devtools-mcp")
    expect(serialized).not.toMatch(/"(command|args|env|url|headers)"/)
  })

  it("never connects just to count tools — a pending import has no toolCount", async () => {
    const mcpProxy = fakeProxy([
      {
        alias: "chrome-devtools",
        importId: IMPORTED_SNAPSHOT.id,
        source: "claude-code",
        type: "stdio",
        status: "pending",
        toolCount: 0,
      },
    ])

    const inventory = await computeCapabilitiesInventory({
      mcpProxy,
      loadImportedMcps: async () => IMPORTED_CONFIG,
      discoverMcps: async () => [],
      loadConfig: async () => ({}),
    })

    expect(inventory.mcp.imported[0]?.status).toBe("idle")
    expect(inventory.mcp.imported[0]?.toolCount).toBeUndefined()
  })

  it("reports unknown status with no mcpProxy wired, and never throws", async () => {
    const inventory = await computeCapabilitiesInventory({
      loadImportedMcps: async () => IMPORTED_CONFIG,
      discoverMcps: async () => [],
      loadConfig: async () => ({}),
    })
    expect(inventory.mcp.imported[0]?.status).toBe("unknown")
  })

  it("a failing skills scan still returns a populated mcp block", async () => {
    const mcpProxy = fakeProxy([])
    const inventory = await computeCapabilitiesInventory({
      mcpProxy,
      loadImportedMcps: async () => IMPORTED_CONFIG,
      discoverMcps: async () => [DISCOVERED_ONLY],
      loadConfig: async () => {
        throw new Error("config.json is corrupt")
      },
    })

    expect(inventory.mcp.error).toBeUndefined()
    expect(inventory.mcp.imported).toHaveLength(1)
    expect(inventory.mcp.discovered).toHaveLength(1)

    expect(inventory.skills.error).toContain("config.json is corrupt")
    expect(inventory.skills.packs).toEqual([])
    expect(inventory.skills.byHarness).toEqual([])
  })

  it("a failing mcp discovery still returns the skills block", async () => {
    const inventory = await computeCapabilitiesInventory({
      loadImportedMcps: async () => {
        throw new Error("imported-mcps.json is corrupt")
      },
      discoverMcps: async () => [],
      loadConfig: async () => ({ defaults: { skills: ["a", "b"] } }),
    })

    expect(inventory.mcp.error).toContain("imported-mcps.json is corrupt")
    expect(inventory.mcp.imported).toEqual([])
    expect(inventory.skills.error).toBeUndefined()
    expect(inventory.skills.defaults.global).toEqual(["a", "b"])
  })
})

describe("capabilities_inventory MCP tool", () => {
  it("is registered and dispatches through to the shared builder", async () => {
    const registry = createSessionsRegistry({ persist: false })
    const { server } = await createMcpServer({ specs: [], name: "test", version: "0" })
    registerSessionTools(server, { registry, workspace: process.cwd() })

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    const client = new Client({ name: "test-client", version: "0" })
    await client.connect(clientTransport)

    const result = (await client.callTool({ name: "capabilities_inventory", arguments: {} })) as {
      content: Array<{ type: string; text: string }>
      isError?: boolean
    }
    expect(result.isError).toBeFalsy()
    const inventory = JSON.parse(result.content[0]!.text) as {
      mcp: { imported: unknown[]; discovered: unknown[] }
      skills: { packs: unknown[]; byHarness: unknown[] }
    }
    // This dispatches through to the REAL loadImportedMcps/discoverMcps/
    // loadConfig (registerSessionTools wires no test seams for them) — the
    // shapes are asserted, not the contents, since those depend on whatever
    // happens to be on the machine running the test.
    expect(Array.isArray(inventory.mcp.imported)).toBe(true)
    expect(Array.isArray(inventory.mcp.discovered)).toBe(true)
    expect(Array.isArray(inventory.skills.packs)).toBe(true)
    expect(Array.isArray(inventory.skills.byHarness)).toBe(true)

    await client.close()
  })
})

describe("capabilities inventory — per-import reach (P2)", () => {
  const adapters = [
    { slug: "claude-code", protocol: "acp" },
    { slug: "hermes", protocol: "acp" },
    { slug: "opencode", protocol: "acp" },
    { slug: "printer", protocol: "print" },
  ] as never
  const bundles = {
    version: 1 as const,
    bundles: [
      { id: "harness-claude-code", label: "cc", mcpImports: ["a"], skills: [] },
      { id: "everything", label: "all", mcpImports: "*" as const, skills: [] },
      { id: "withdaemon", label: "d", mcpImports: [], includeDaemon: true, skills: [] },
    ],
  }

  it("empty defaults: daemon-default harnesses are indirect, the rest none", () => {
    const m = computeImportedReach(["a"], adapters, {}, bundles)
    expect(m.get("a")).toEqual({ "claude-code": "indirect", hermes: "indirect", opencode: "none", printer: "none" })
  })

  it("a default bundle makes its imports native for that adapter only", () => {
    const m = computeImportedReach(["a", "b"], adapters, { defaults: { adapters: { "claude-code": { bundles: ["harness-claude-code"] } } } }, bundles)
    expect(m.get("a")?.["claude-code"]).toBe("native")
    expect(m.get("b")?.["claude-code"]).toBe("indirect")
    expect(m.get("a")?.hermes).toBe("indirect")
  })

  it('"*" is native for every listed import; non-ACP adapters never native; includeDaemon/daemonMount make on-request adapters indirect', () => {
    const m = computeImportedReach(
      ["a", "b"],
      adapters,
      { defaults: { bundles: ["everything"], adapters: { opencode: { bundles: ["withdaemon"] }, hermes: { daemonMount: true } } } },
      bundles,
    )
    expect(m.get("b")).toEqual({ "claude-code": "native", hermes: "native", opencode: "native", printer: "none" })
    const n = computeImportedReach(["a"], adapters, { defaults: { adapters: { opencode: { bundles: ["withdaemon"] } } } }, bundles)
    expect(n.get("a")?.opencode).toBe("indirect")
  })

  it("is wired into the inventory (via injected loadBundles/loadConfig) without leaking bundle content", async () => {
    const inventory = await computeCapabilitiesInventory({
      listAgentAdapters: async () => [{ slug: "claude-code", protocol: "acp", packageName: "@agentproto/nope" }] as never,
      loadImportedMcps: async () => IMPORTED_CONFIG,
      discoverMcps: async () => [],
      loadConfig: async () => ({ defaults: { adapters: { "claude-code": { bundles: ["harness-claude-code"] } } } }),
      loadBundles: async () => ({
        version: 1,
        bundles: [{ id: "harness-claude-code", label: "cc", mcpImports: [IMPORTED_SNAPSHOT.id], skills: [] }],
      }),
    })
    expect(inventory.mcp.imported[0]?.reach).toEqual({ "claude-code": "native" })
  })
})
