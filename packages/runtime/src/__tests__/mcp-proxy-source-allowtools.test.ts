/**
 * An import's source-side `allowTools` is enforced by the registry itself,
 * so every path (`/mcp/imported/<id>`, `mcp_imported_tool_list`,
 * `mcp_imported_call`) sees the same narrowed surface. The upstream here is a
 * fake MCP server exposing read tools and write-looking tools; the write
 * tools record any call that reaches them, which must stay empty.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createServer, type Server } from "node:http"
import { AddressInfo } from "node:net"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"
import { z } from "zod"

import { McpProxyRegistry } from "../mcp-proxy.js"
import { addImport, loadImportedMcps } from "../mcp-imports.js"
import type { DiscoveredMcp } from "../mcp-discovery.js"

const READS = ["list_items", "get_item"]
const WRITES = ["create_item", "delete_item", "send_item"]

let upstream: Server | undefined
let home: string
const realHome = process.env.HOME
beforeEach(() => {
  // `IMPORTED_MCPS_PATH` is `~/.agentproto/imported-mcps.json`: point HOME at
  // a scratch dir so the registry reads a real file.
  home = mkdtempSync(join(tmpdir(), "ap-allowtools-"))
  mkdirSync(join(home, ".agentproto"), { recursive: true })
  process.env.HOME = home
})
afterEach(() => {
  upstream?.close()
  upstream = undefined
  process.env.HOME = realHome
  rmSync(home, { recursive: true, force: true })
})

function writeImports(imports: unknown[]) {
  writeFileSync(
    join(home, ".agentproto", "imported-mcps.json"),
    JSON.stringify({ version: 1, imports }),
  )
}

async function startUpstream() {
  const reached: string[] = []
  upstream = createServer(async (req, res) => {
    const server = new McpServer({ name: "fake-upstream", version: "0" })
    for (const name of [...READS, ...WRITES]) {
      server.tool(name, name, { x: z.string().optional() }, async () => {
        reached.push(name)
        return { content: [{ type: "text", text: `ok:${name}` }] }
      })
    }
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
    res.on("close", () => void transport.close())
    await server.connect(transport)
    let body = ""
    for await (const c of req) body += c
    await transport.handleRequest(req, res, body ? JSON.parse(body) : undefined)
  })
  await new Promise<void>(r => upstream!.listen(0, "127.0.0.1", r))
  const port = (upstream.address() as AddressInfo).port
  const snapshot: DiscoveredMcp = {
    id: "manual:cli:fake-ledger",
    name: "fake-ledger",
    source: "workspace",
    scope: "cli",
    type: "http",
    url: `http://127.0.0.1:${port}/`,
  }
  return { snapshot, reached }
}

describe("import-level allowTools (source-side)", () => {
  it("loads a valid list and fails CLOSED on a malformed one", async () => {
    const snapshot = { id: "i", name: "a", source: "workspace", scope: "cli", type: "http" }
    writeImports([
      { id: "i", alias: "a", snapshot, allowTools: ["list_*", "", 3] },
      { id: "j", alias: "b", snapshot, allowTools: "list_*" },
      { id: "k", alias: "c", snapshot },
    ])
    const cfg = await loadImportedMcps()
    expect(cfg.imports.find(e => e.id === "i")?.allowTools).toEqual(["list_*"])
    expect(cfg.imports.find(e => e.id === "j")?.allowTools).toEqual([])
    expect(cfg.imports.find(e => e.id === "k")?.allowTools).toBeUndefined()
  })

  it("re-importing an id keeps its allow-list unless a new one is given", () => {
    const snapshot: DiscoveredMcp = { id: "i", name: "a", source: "workspace", scope: "cli", type: "http" }
    const first = addImport({ version: 1, imports: [] }, { snapshot, allowTools: ["list_*"] })
    const again = addImport(first, { snapshot })
    expect(again.imports[0]?.allowTools).toEqual(["list_*"])
    const widened = addImport(first, { snapshot, allowTools: ["list_*", "get_*"] })
    expect(widened.imports[0]?.allowTools).toEqual(["list_*", "get_*"])
  })

  it("hides write tools from the list and refuses their calls before the upstream; reads work", async () => {
    const { snapshot, reached } = await startUpstream()
    writeImports([
      { id: snapshot.id, alias: "fake-ledger", addedAt: "", snapshot, allowTools: ["list_*", "get_*"] },
    ])
    const registry = new McpProxyRegistry()

    const listed = await registry.listTools("fake-ledger")
    expect(listed.ok).toBe(true)
    if (listed.ok) expect(listed.tools.map(t => t.name).sort()).toEqual([...READS].sort())

    for (const w of WRITES) {
      const out = await registry.callTool("fake-ledger", w, {})
      expect(out.ok, w).toBe(false)
    }
    expect(reached).toEqual([])

    const ok = await registry.callTool("fake-ledger", "list_items", {})
    expect(ok.ok).toBe(true)
    expect(reached).toEqual(["list_items"])
  })

  it("an import without allowTools is unrestricted (unchanged behaviour)", async () => {
    const { snapshot } = await startUpstream()
    writeImports([{ id: snapshot.id, alias: "fake-ledger", addedAt: "", snapshot }])
    const listed = await new McpProxyRegistry().listTools("fake-ledger")
    expect(listed.ok && listed.tools.length).toBe(READS.length + WRITES.length)
  })
})
