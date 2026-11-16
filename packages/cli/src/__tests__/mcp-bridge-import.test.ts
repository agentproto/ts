/**
 * `agentproto mcp-bridge --import <alias|importId>` dials the daemon's
 * per-import passthrough `/mcp/imported/<ref>` (one imported server, native
 * tool names) instead of `/mcp`, keeps an explicit AGENTPROTO_MCP_URL's origin
 * and query, and refuses bad values or `--surface` before anything connects.
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
import { parseBridgeArgs, withImport } from "../commands/mcp-bridge.logic.js"

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

describe("mcp-bridge --import", () => {
  it("dials /mcp/imported/<alias> on the default daemon URL", async () => {
    await runMcpBridge(["--import", "bureau"])
    expect(dialed).toEqual(["http://127.0.0.1:18790/mcp/imported/bureau"])
  })

  it("accepts --import=<importId>", async () => {
    await runMcpBridge(["--import=imp_1a2b-3c"])
    expect(dialed).toEqual(["http://127.0.0.1:18790/mcp/imported/imp_1a2b-3c"])
  })

  it("keeps the origin and the query of an explicit AGENTPROTO_MCP_URL", async () => {
    process.env.AGENTPROTO_MCP_URL = "http://127.0.0.1:19999/mcp?callerSessionId=claude-desktop&host=claude-desktop"
    await runMcpBridge(["--import", "bureau"])
    expect(dialed).toEqual([
      "http://127.0.0.1:19999/mcp/imported/bureau?callerSessionId=claude-desktop&host=claude-desktop",
    ])
  })

  it("refuses --import together with --surface, in either order, without dialing", async () => {
    for (const args of [
      ["--import", "bureau", "--surface", "approval-cards"],
      ["--surface=approval-cards", "--import=bureau"],
    ]) {
      expect(await runMcpBridge(args)).toBe(2)
    }
    expect(dialed).toEqual([])
    expect(stderr.join("")).toContain("--import can not be combined with --surface")
  })

  it("refuses --import with no value or a path-like value", async () => {
    for (const args of [["--import"], ["--import", "--surface"], ["--import", "../mcp"], ["--import=a/b"], ["--import="]]) {
      expect(await runMcpBridge(args)).toBe(2)
    }
    expect(dialed).toEqual([])
  })

  it("without --import the default URL is still /mcp", async () => {
    await runMcpBridge([])
    expect(dialed).toEqual(["http://127.0.0.1:18790/mcp"])
  })
})

describe("parseBridgeArgs / withImport (unit)", () => {
  it("parses --import and leaves surface unset", () => {
    expect(parseBridgeArgs(["--import", "bureau"])).toEqual({ importRef: "bureau" })
  })
  it("encodes the ref in the path", () => {
    expect(withImport("http://h:1/mcp?x=1", "a:b")).toBe("http://h:1/mcp/imported/a%3Ab?x=1")
  })
})
