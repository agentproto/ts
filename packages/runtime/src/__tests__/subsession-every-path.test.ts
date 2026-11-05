/**
 * AIP-59 section 8: every call from an agent session to an import declared
 * `subsession: "aip-59"` must carry that session's sub-session token, through
 * BOTH gateway paths:
 *
 *   - the bundle-mounted `/mcp/imported/<id>` passthrough (the harness calls
 *     `bureau_*` tools directly),
 *   - `mcp_imported_call` on the daemon's own `/mcp`.
 *
 * The registry is opened by import id on the bundle path and by alias on the
 * tool path; both must reach the same mint. Nothing here talks to a real
 * Bureau: one in-process HTTP server answers `POST /pair/subsessions`,
 * `DELETE /pair/subsessions/<id>` and serves a streamable-HTTP MCP endpoint.
 */

import { afterEach, describe, expect, it } from "vitest"
import { createServer, type IncomingMessage, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { spawn, type ChildProcess } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, utimesSync } from "node:fs"
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

const IMPORT_ID = "fixture:global:bureau"
const IMPORT_ALIAS = "bureau"
const DEVICE_TOKEN = "Bearer device-secret"

interface ObservedCall {
  subsession?: string
  caller?: string
}

interface FakeBureau {
  url: string
  mints: Array<{ sessionId: string; authorization?: string }>
  deletes: string[]
  calls: ObservedCall[]
  toolCalls: number
  mintStatus: number
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
  const state = {
    mints: [] as Array<{ sessionId: string; authorization?: string }>,
    deletes: [] as string[],
    calls: [] as ObservedCall[],
    toolCalls: 0,
    mintStatus: 200,
  }
  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1")
    if (url.pathname === "/pair/subsessions" && req.method === "POST") {
      const body = JSON.parse((await readBody(req)) || "{}") as { sessionId?: string }
      state.mints.push({
        sessionId: body.sessionId ?? "",
        ...(typeof req.headers.authorization === "string"
          ? { authorization: req.headers.authorization }
          : {}),
      })
      if (state.mintStatus !== 200) {
        res.writeHead(state.mintStatus, { "content-type": "application/json" })
        res.end(JSON.stringify({ error: "mint refused" }))
        return
      }
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
      state.deletes.push(decodeURIComponent(url.pathname.slice("/pair/subsessions/".length)))
      res.writeHead(204)
      res.end()
      return
    }
    if (url.pathname === "/mcp") {
      // A per-call header is present only on `tools/call` (the guard's headers
      // are wrapped around exactly that RPC), so a recorded entry IS a call.
      const subsession = req.headers["agentproto-subsession"]
      const caller = req.headers["x-agentproto-caller-session"]
      if (subsession || caller) {
        state.calls.push({
          ...(typeof subsession === "string" ? { subsession } : {}),
          ...(typeof caller === "string" ? { caller } : {}),
        })
      }
      const mcp = new McpServer({ name: "fake-bureau", version: "1.0.0" })
      mcp.registerTool("navigate", { description: "navigate a tab" }, async () => {
        state.toolCalls += 1
        return { content: [{ type: "text", text: "navigated" }] }
      })
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
    get deletes() {
      return state.deletes
    },
    get calls() {
      return state.calls
    },
    get toolCalls() {
      return state.toolCalls
    },
    get mintStatus() {
      return state.mintStatus
    },
    set mintStatus(value: number) {
      state.mintStatus = value
    },
    async close() {
      server.closeAllConnections?.()
      await new Promise<void>(resolve => server.close(() => resolve()))
    },
  }
}

function entry(url: string, withSubsession: boolean): ImportedMcpEntry {
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
      headers: { authorization: DEVICE_TOKEN },
    },
    ...(withSubsession ? { subsession: "aip-59" as const } : {}),
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error("timed out waiting for condition")
}

describe("AIP-59 sub-session token on every gateway path", () => {
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

  async function boot(withSubsession: boolean): Promise<{
    gateway: GatewayHandle
    bureau: FakeBureau
    workspace: string
    session: { id: string; child: ChildProcess }
  }> {
    const bureau = await startFakeBureau()
    cleanups.push(() => bureau.close())
    const workspace = mkdtempSync(join(tmpdir(), "aip59-every-path-ws-"))
    cleanups.push(() => rmSync(workspace, { recursive: true, force: true }))
    mkdirSync(join(process.env["HOME"]!, ".agentproto"), { recursive: true })
    mkdirSync(join(workspace, ".agentproto"), { recursive: true })
    await saveImportedMcps(
      { version: 1, imports: [entry(bureau.url, withSubsession)] },
      IMPORTED_MCPS_PATH(),
    )
    const gateway = await createGateway({
      workspace,
      specs: [],
      port: await freePort(),
      boot: false,
      persist: false,
    })
    cleanups.push(() => gateway.stop())
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    })
    cleanups.push(() => {
      if (!child.killed) child.kill("SIGKILL")
    })
    const descriptor = gateway.sessions.register({
      child,
      id: "sess_aip59_fixture",
      workspaceSlug: "default",
      command: "fake-agent",
      cwd: workspace,
      kind: "agent-cli",
    })
    return { gateway, bureau, workspace, session: { id: descriptor.id, child } }
  }

  async function callBundle(gateway: GatewayHandle, sessionId: string): Promise<unknown> {
    const client = new Client({ name: "aip59-bundle", version: "0.0.1" })
    const transport = new StreamableHTTPClientTransport(
      new URL(
        `${gateway.url}/mcp/imported/${encodeURIComponent(IMPORT_ID)}` +
          `?callerSessionId=${encodeURIComponent(sessionId)}`,
      ),
    )
    await client.connect(transport)
    try {
      return await client.callTool({ name: "navigate", arguments: {} })
    } finally {
      await client.close()
    }
  }

  async function callImported(
    gateway: GatewayHandle,
    sessionId: string,
    alias: string,
  ): Promise<unknown> {
    const client = new Client({ name: "aip59-imported-call", version: "0.0.1" })
    const transport = new StreamableHTTPClientTransport(
      new URL(`${gateway.url}/mcp?callerSessionId=${encodeURIComponent(sessionId)}`),
    )
    await client.connect(transport)
    try {
      return await client.callTool({
        name: "mcp_imported_call",
        arguments: { alias, toolName: "navigate", args: {} },
      })
    } finally {
      await client.close()
    }
  }

  it("bundle-mounted passthrough carries the session's sub-session token", async () => {
    const { gateway, bureau, session } = await boot(true)

    await callBundle(gateway, session.id)

    expect(bureau.mints).toHaveLength(1)
    expect(bureau.mints[0]).toMatchObject({
      sessionId: session.id,
      authorization: DEVICE_TOKEN,
    })
    expect(bureau.calls).toHaveLength(1)
    expect(bureau.calls[0]?.subsession).toBe(`tok-${session.id}`)
    expect(bureau.calls[0]?.caller).toBeUndefined()
  })

  it("mcp_imported_call carries the token by alias AND by import id, one mint", async () => {
    const { gateway, bureau, session } = await boot(true)

    await callImported(gateway, session.id, IMPORT_ALIAS)
    await callImported(gateway, session.id, IMPORT_ID)

    expect(bureau.mints).toHaveLength(1)
    expect(bureau.calls).toHaveLength(2)
    expect(bureau.calls[0]?.subsession).toBe(`tok-${session.id}`)
    expect(bureau.calls[1]?.subsession).toBe(`tok-${session.id}`)
    expect(bureau.calls.every(c => c.caller === undefined)).toBe(true)
  })

  it("a mint failure is fail-closed with a clear reason and never reaches the upstream", async () => {
    const { gateway, bureau, session } = await boot(true)
    bureau.mintStatus = 500

    const result = (await callBundle(gateway, session.id)) as {
      isError?: boolean
      content?: Array<{ type: string; text: string }>
    }

    expect(result.isError).toBe(true)
    expect(result.content?.[0]?.text).toContain("could not mint a sub-session token")
    expect(result.content?.[0]?.text).toContain("HTTP 500")
    expect(bureau.toolCalls).toBe(0)
    expect(bureau.calls).toHaveLength(0)
  })

  it("opting in after boot works without a daemon restart", async () => {
    const { gateway, bureau, session } = await boot(false)

    await callBundle(gateway, session.id)
    expect(bureau.calls[0]?.subsession).toBeUndefined()

    await saveImportedMcps(
      { version: 1, imports: [entry(bureau.url, true)] },
      IMPORTED_MCPS_PATH(),
    )
    const ahead = new Date(Date.now() + 5_000)
    utimesSync(IMPORTED_MCPS_PATH(), ahead, ahead)

    await callBundle(gateway, session.id)
    expect(bureau.mints).toHaveLength(1)
    expect(bureau.calls[1]?.subsession).toBe(`tok-${session.id}`)
    expect(bureau.calls[1]?.caller).toBeUndefined()
  })

  it("revokes the session's token when the session ends", async () => {
    const { gateway, bureau, session } = await boot(true)

    await callBundle(gateway, session.id)
    expect(bureau.mints).toHaveLength(1)

    gateway.sessions.kill(session.id)
    await waitFor(() => bureau.deletes.length > 0)
    expect(bureau.deletes).toEqual([session.id])
  })
})
