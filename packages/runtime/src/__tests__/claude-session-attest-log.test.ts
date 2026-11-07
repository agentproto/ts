/**
 * Debug trail for the Claude Code session attestation: one line per distinct
 * outcome, never per request, never a secret.
 */

import { afterEach, describe, expect, it, vi } from "vitest"
import { createServer } from "node:http"
import { AddressInfo } from "node:net"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { createMcpServer } from "@agentproto/mcp-server"

import { startHttpServer } from "../http-server.js"
import { createRuntimeEvents } from "../events.js"
import { classifyAttestation, createAttestationLogGate } from "../claude-session-attest-log.js"
import type { ConversationStore } from "../conversations.js"
import type { HeartbeatRunner } from "../heartbeat.js"

const HEADER = "x-agentproto-claude-session"
const ID = "0b9f2c1e-4d3a-4f6b-9c1d-7e8a5b6c7d8e"

describe("classifyAttestation", () => {
  const base = { shared: "claude-desktop", trusted: true }
  it("resolved / refused / absent", () => {
    expect(classifyAttestation({ ...base, header: ID, query: "claude-desktop" })).toMatchObject({ kind: "resolved", idPrefix: "0b9f2c1e" })
    expect(classifyAttestation({ ...base, header: "bad id", query: "claude-desktop" })).toMatchObject({ kind: "refused", reason: "invalid_format" })
    expect(classifyAttestation({ ...base, header: ID, query: "sess_x" })).toMatchObject({ kind: "refused", reason: "identity_not_shared" })
    expect(classifyAttestation({ ...base, trusted: false, header: ID, query: undefined })).toMatchObject({ kind: "refused", reason: "untrusted_request" })
    expect(classifyAttestation({ ...base, header: undefined, query: "claude-desktop" })).toMatchObject({ kind: "absent" })
    expect(classifyAttestation({ ...base, header: undefined, query: undefined })).toMatchObject({ kind: "absent" })
    expect(classifyAttestation({ ...base, header: undefined, query: "sess_x" })).toBeUndefined()
  })
})

describe("createAttestationLogGate", () => {
  it("logs once per distinct outcome, re-emits after the window, bounds its memory", () => {
    let t = 0
    const lines: string[] = []
    const gate = createAttestationLogGate(l => lines.push(l), { reemitMs: 1000, now: () => t, maxKeys: 2 })
    const o = classifyAttestation({ header: ID, query: "claude-desktop", shared: "claude-desktop", trusted: true })
    for (let i = 0; i < 50; i++) gate(o)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toBe("[mcp] claude-session attestation: header accepted, caller resolved to cc:0b9f2c1e (url identity: claude-desktop)")
    expect(lines[0]).not.toContain(ID)
    t = 1500
    gate(o)
    expect(lines).toHaveLength(2)
    gate(classifyAttestation({ header: undefined, query: undefined, shared: "claude-desktop", trusted: true }))
    gate(classifyAttestation({ header: "bad id", query: undefined, shared: "claude-desktop", trusted: true }))
    expect(lines.at(-1)).toContain("refused (invalid_format")
    expect(lines.join("\n")).not.toContain("bad id")
  })
})

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.once("error", reject)
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as AddressInfo).port
      srv.close(() => resolve(port))
    })
  })
}

describe("daemon logs the attestation decision once per connection kind", () => {
  afterEach(() => vi.restoreAllMocks())

  it("emits one line for many requests, with the right decision", async () => {
    const captured: string[] = []
    const orig = console.error
    vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
      const s = a.map(String).join(" ")
      if (s.includes("claude-session attestation")) captured.push(s)
      else orig(...a)
    })
    const mcpServerFactory = async () => {
      const { server } = await createMcpServer({ specs: [], name: "main", version: "0" })
      server.tool("probe", "probe", {}, async () => ({ content: [{ type: "text" as const, text: "ok" }] }))
      return server
    }
    const noConv: ConversationStore = {
      async open() {},
      async appendTurn() {},
      async read() {
        return { meta: {} as never, turns: [] }
      },
      async list() {
        return []
      },
      pathFor: (id: string) => id,
    }
    const hb: HeartbeatRunner = { start() {}, stop() {}, async fireNow() {} }
    const port = await freePort()
    const http = await startHttpServer({
      port,
      auth: { mode: "none" },
      mcpServerFactory,
      conversations: noConv,
      events: createRuntimeEvents(),
      heartbeat: hb,
      meta: { workspace: process.cwd(), registered: [] },
    })
    const dial = async (headers: Record<string, string>) => {
      const client = new Client({ name: "attest-log", version: "0.0.1" })
      await client.connect(
        new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp?callerSessionId=claude-desktop&host=claude-desktop`), {
          requestInit: { headers },
        }),
      )
      await client.listTools()
      await client.listTools()
      await client.close()
    }
    try {
      await dial({ [HEADER]: ID })
      await dial({ [HEADER]: ID })
      await dial({ [HEADER]: "bad id!" })
      await dial({})
    } finally {
      await http.stop()
    }
    expect(captured).toHaveLength(3)
    expect(captured[0]).toContain("caller resolved to cc:0b9f2c1e")
    expect(captured[1]).toContain("refused (invalid_format")
    expect(captured[2]).toContain("no header on a shared/anonymous connection")
    expect(captured.join("\n")).not.toContain(ID)
  })
})
