/**
 * The bridge attests the real Claude Code session to the daemon: when
 * CLAUDE_CODE_SESSION_ID is set (and well formed) every proxied request carries
 * `x-agentproto-claude-session`; otherwise the header is absent.
 *
 * Transport and client are replaced: the transport records its options and the
 * client's connect fails, so `runMcpBridge` returns 1 right after dialing.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const { opts } = vi.hoisted(() => ({ opts: [] as Array<Record<string, unknown> | undefined> }))

vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: class {
    constructor(_url: URL, o?: Record<string, unknown>) {
      opts.push(o)
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

import { runMcpBridge } from "../commands/mcp-bridge.js"
import {
  CLAUDE_SESSION_HEADER,
  claudeSessionHeaders,
  readClaudeSessionId,
} from "../commands/mcp-bridge.logic.js"

const ID = "0b9f2c1e-4d3a-4f6b-9c1d-7e8a5b6c7d8e"
let saved: { url?: string; sid?: string }
let stderr: string[]

beforeEach(() => {
  opts.length = 0
  stderr = []
  saved = { url: process.env.AGENTPROTO_MCP_URL, sid: process.env.CLAUDE_CODE_SESSION_ID }
  process.env.AGENTPROTO_MCP_URL = "http://127.0.0.1:18790/mcp?callerSessionId=claude-desktop&host=claude-desktop"
  delete process.env.CLAUDE_CODE_SESSION_ID
  vi.spyOn(process.stderr, "write").mockImplementation(((chunk: string | Uint8Array) => {
    stderr.push(String(chunk))
    return true
  }) as typeof process.stderr.write)
})

afterEach(() => {
  vi.restoreAllMocks()
  for (const [k, v] of [["AGENTPROTO_MCP_URL", saved.url], ["CLAUDE_CODE_SESSION_ID", saved.sid]] as const) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
})

describe("mcp-bridge Claude Code session attestation", () => {
  it("forwards the session header when CLAUDE_CODE_SESSION_ID is set", async () => {
    process.env.CLAUDE_CODE_SESSION_ID = ID
    await runMcpBridge([])
    const headers = (opts[0]?.requestInit as { headers?: Record<string, string> } | undefined)?.headers
    expect(headers).toEqual({ [CLAUDE_SESSION_HEADER]: ID })
    expect(stderr.join("")).not.toContain(ID)
    expect(stderr.join("")).toContain(ID.slice(0, 8))
  })

  it("omits the header when the env var is not set", async () => {
    await runMcpBridge([])
    const headers = (opts[0]?.requestInit as { headers?: Record<string, string> } | undefined)?.headers
    expect(headers ?? {}).toEqual({})
  })

  it("ignores a malformed id", async () => {
    for (const bad of ["", "a b", "x/../y", "cc:abc", "a".repeat(129), "id\nx-evil: 1"]) {
      process.env.CLAUDE_CODE_SESSION_ID = bad
      opts.length = 0
      await runMcpBridge([])
      const headers = (opts[0]?.requestInit as { headers?: Record<string, string> } | undefined)?.headers
      expect(headers ?? {}).toEqual({})
    }
  })

  it("logic: readClaudeSessionId / claudeSessionHeaders", () => {
    expect(readClaudeSessionId({ CLAUDE_CODE_SESSION_ID: ` ${ID} ` })).toBe(ID)
    expect(readClaudeSessionId({})).toBeUndefined()
    expect(claudeSessionHeaders({ CLAUDE_CODE_SESSION_ID: "bad id" })).toEqual({})
  })
})

describe("mcp-bridge startup attestation line (stderr)", () => {
  const line = () => stderr.filter(l => l.startsWith("[mcp-bridge] claude session header:"))

  it("states sent with the first 8 chars, and whether callerSessionId is in the url", async () => {
    process.env.CLAUDE_CODE_SESSION_ID = ID
    await runMcpBridge([])
    expect(line()).toEqual([`[mcp-bridge] claude session header: sent (id=${ID.slice(0, 8)}); callerSessionId in url: yes\n`])
  })

  it("states not sent (unset)", async () => {
    await runMcpBridge([])
    expect(line()).toEqual(["[mcp-bridge] claude session header: not sent (CLAUDE_CODE_SESSION_ID unset); callerSessionId in url: yes\n"])
  })

  it("states not sent (invalid) and never echoes the value or url secrets", async () => {
    process.env.CLAUDE_CODE_SESSION_ID = "bad id!"
    process.env.AGENTPROTO_MCP_URL = "http://127.0.0.1:18790/mcp?token=SECRET"
    await runMcpBridge([])
    expect(line()).toEqual(["[mcp-bridge] claude session header: not sent (CLAUDE_CODE_SESSION_ID invalid); callerSessionId in url: no\n"])
    expect(stderr.join("")).not.toContain("SECRET")
    expect(stderr.join("")).not.toContain("bad id!")
  })
})
