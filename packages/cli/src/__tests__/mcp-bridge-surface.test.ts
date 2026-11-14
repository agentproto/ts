/**
 * `agentproto mcp-bridge --surface approval-cards` dials the daemon's cards
 * surface, an explicit AGENTPROTO_MCP_URL keeps its query string, and any
 * other surface name is refused before anything connects.
 *
 * The SDK client and transport are replaced: the transport records the URL it
 * is given and the client's connect fails, so `runMcpBridge` returns 1 right
 * after dialing instead of parking as a stdio server.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const { dialed } = vi.hoisted(() => ({ dialed: [] as string[] }))

vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: class {
    constructor(url: URL) {
      dialed.push(url.toString())
    }
  },
}))

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: class {
    async connect(): Promise<void> {
      throw new Error("refused (test)")
    }
  },
}))

vi.mock("@agentproto/runtime/config", async importOriginal => {
  const orig = await importOriginal<typeof import("@agentproto/runtime/config")>()
  return { ...orig, loadConfig: async () => ({ daemon: { port: 18790 } }) }
})

import { runMcpBridge } from "../commands/mcp-bridge.js"

let savedUrl: string | undefined
let stderr: string[]

beforeEach(() => {
  dialed.length = 0
  stderr = []
  savedUrl = process.env.AGENTPROTO_MCP_URL
  delete process.env.AGENTPROTO_MCP_URL
  vi.spyOn(process.stderr, "write").mockImplementation(((chunk: string | Uint8Array) => {
    stderr.push(String(chunk))
    return true
  }) as typeof process.stderr.write)
})

afterEach(() => {
  vi.restoreAllMocks()
  if (savedUrl === undefined) delete process.env.AGENTPROTO_MCP_URL
  else process.env.AGENTPROTO_MCP_URL = savedUrl
})

describe("mcp-bridge --surface", () => {
  it("dials the default URL with ?surface=approval-cards", async () => {
    await runMcpBridge(["--surface", "approval-cards"])
    expect(dialed).toEqual(["http://127.0.0.1:18790/mcp?surface=approval-cards"])
  })

  it("accepts --surface=approval-cards", async () => {
    await runMcpBridge(["--surface=approval-cards"])
    expect(dialed).toEqual(["http://127.0.0.1:18790/mcp?surface=approval-cards"])
  })

  it("adds the surface to an explicit AGENTPROTO_MCP_URL and keeps its other query parameters", async () => {
    process.env.AGENTPROTO_MCP_URL = "http://127.0.0.1:19999/mcp?host=claude-desktop"
    await runMcpBridge(["--surface", "approval-cards"])
    expect(dialed).toEqual(["http://127.0.0.1:19999/mcp?host=claude-desktop&surface=approval-cards"])
  })

  it("keeps the query string of an explicit AGENTPROTO_MCP_URL when no flag is given", async () => {
    process.env.AGENTPROTO_MCP_URL = "http://127.0.0.1:18790/mcp?surface=approval-cards"
    await runMcpBridge([])
    expect(dialed).toEqual(["http://127.0.0.1:18790/mcp?surface=approval-cards"])
  })

  it("without the flag the default URL has no query", async () => {
    await runMcpBridge([])
    expect(dialed).toEqual(["http://127.0.0.1:18790/mcp"])
  })

  it("refuses another surface name without dialing", async () => {
    const code = await runMcpBridge(["--surface", "admin"])
    expect(code).toBe(2)
    expect(dialed).toEqual([])
    expect(stderr.join("")).toContain('unknown surface "admin"')
    expect(stderr.join("")).toContain("approval-cards")
  })

  it("refuses --surface with no value", async () => {
    const code = await runMcpBridge(["--surface"])
    expect(code).toBe(2)
    expect(dialed).toEqual([])
  })
})
