/**
 * AIP-59 caller identity through the daemon's browser proxy: two caller
 * sessions must reach Bureau as two different owners. The fake Bureau mints a
 * per-session sub-session token and records the `agentproto-subsession` header
 * on each `tools/call`, the same way agentproto/bureau#41 checks ownership.
 */

import { afterEach, describe, expect, it } from "vitest"
import { createServer, type IncomingMessage, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { spawn, type ChildProcess } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"

import { createGateway, type GatewayHandle } from "../index.js"
import {
  IMPORTED_MCPS_PATH,
  saveImportedMcps,
  type ImportedMcpEntry,
} from "../mcp-imports.js"

const IMPORT_ID = "fixture:global:bureau-owner"
const IMPORT_ALIAS = "bureau"

interface FakeBureau {
  url: string
  mints: string[]
  calls: Array<{ subsession?: string }>
  close(): Promise<void>
}

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

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = ""
    req.setEncoding("utf8")
    req.on("data", chunk => (body += chunk))
    req.on("end", () => resolve(body))
    req.on("error", reject)
  })
}

async function startFakeBureau(): Promise<FakeBureau> {
  const state = { mints: [] as string[], calls: [] as Array<{ subsession?: string }> }
  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1")
    if (url.pathname === "/pair/subsessions" && req.method === "POST") {
      const body = JSON.parse((await readBody(req)) || "{}") as { sessionId?: string }
      state.mints.push(body.sessionId ?? "")
      res.writeHead(200, { "content-type": "application/json" })
      res.end(
        JSON.stringify({
          token: `tok-${body.sessionId ?? ""}`,
          sessionId: body.sessionId,
          expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        }),
      )
      return
    }
    if (url.pathname.startsWith("/pair/subsessions/") && req.method === "DELETE") {
      res.writeHead(204)
      res.end()
      return
    }
    if (url.pathname === "/mcp") {
      const subsession = req.headers["agentproto-subsession"]
      if (typeof subsession === "string") state.calls.push({ subsession })
      const mcp = new McpServer({ name: "fake-bureau-owner", version: "1.0.0" })
      mcp.registerTool("browser_press_key", { description: "press a key" }, async () => ({
        content: [{ type: "text", text: "pressed" }],
      }))
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
      res.on("close", () => {
        void transport.close()
        void mcp.close()
      })
      await mcp.connect(transport)
      await transport.handleRequest(req, res)
      return
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
  const port = (server.address() as AddressInfo).port
  return {
    url: `http://127.0.0.1:${port}`,
    get mints() {
      return state.mints
    },
    get calls() {
      return state.calls
    },
    async close() {
      server.closeAllConnections?.()
      await new Promise<void>(resolve => server.close(() => resolve()))
    },
  }
}

function entry(url: string): ImportedMcpEntry {
  return {
    id: IMPORT_ID,
    alias: IMPORT_ALIAS,
    addedAt: "2026-01-01T00:00:00.000Z",
    snapshot: {
      id: IMPORT_ID,
      source: "workspace",
      scope: "workspace",
      name: IMPORT_ALIAS,
      type: "http",
      url: `${url}/mcp`,
    },
    subsession: "aip-59",
  }
}

describe("browser proxy caller identity", () => {
  const cleanups: Array<() => Promise<void> | void> = []

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) {
      try {
        await cleanup()
      } catch {
        // teardown is best effort
      }
    }
  })

  it("two caller sessions reach Bureau as two different owners", async () => {
    const bureau = await startFakeBureau()
    cleanups.push(() => bureau.close())
    const workspace = mkdtempSync(join(tmpdir(), "browser-owner-ws-"))
    cleanups.push(() => rmSync(workspace, { recursive: true, force: true }))
    mkdirSync(join(process.env["HOME"]!, ".agentproto"), { recursive: true })
    mkdirSync(join(workspace, ".agentproto"), { recursive: true })
    await saveImportedMcps(
      { version: 1, imports: [entry(bureau.url)] },
      IMPORTED_MCPS_PATH(),
    )
    writeFileSync(
      join(process.env["HOME"]!, ".agentproto", "config.json"),
      JSON.stringify({
        defaults: { browser: { builtin: "proxy", proxyImport: IMPORT_ALIAS } },
      }),
      "utf8",
    )
    const gateway: GatewayHandle = await createGateway({
      workspace,
      specs: [],
      port: await freePort(),
      boot: false,
      persist: false,
    })
    cleanups.push(() => gateway.stop())

    const sessions = ["sess_owner_a", "sess_owner_b"].map(id => {
      const child: ChildProcess = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
        stdio: "ignore",
      })
      cleanups.push(() => {
        if (!child.killed) child.kill("SIGKILL")
      })
      gateway.sessions.register({
        child,
        id,
        workspaceSlug: "default",
        command: "fake-agent",
        cwd: workspace,
        kind: "agent-cli",
      })
      return id
    })

    async function pressKey(sessionId: string): Promise<void> {
      const client = new Client({ name: "browser-owner", version: "0.0.1" })
      const transport = new StreamableHTTPClientTransport(
        new URL(`${gateway.url}/mcp?callerSessionId=${encodeURIComponent(sessionId)}`),
      )
      await client.connect(transport)
      try {
        await client.callTool({
          name: "browser_press_key",
          arguments: { sessionId: "daemon-browser-session", key: "Enter" },
        })
      } finally {
        await client.close()
      }
    }

    await pressKey(sessions[0]!)
    await pressKey(sessions[1]!)

    expect(bureau.mints).toEqual(sessions)
    expect(bureau.calls.map(c => c.subsession)).toEqual([
      `tok-${sessions[0]}`,
      `tok-${sessions[1]}`,
    ])
  })
})
