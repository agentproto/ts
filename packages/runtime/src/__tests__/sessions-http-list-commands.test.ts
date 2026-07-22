/**
 * `GET /sessions`'s default-view semantics around `kind:"command"` rows —
 * the HTTP-layer mirror of session-list-commands.test.ts's MCP-tool
 * coverage. Commands are a shell-execution LOG (already reachable via
 * `command_list` / `?kind=command`), not resumable sessions, so they must
 * stay OUT of the default (no `kind` / `?kind=all`) view while remaining
 * reachable via `?kind=command` or `?includeCommands=true`.
 */

import { afterEach, describe, expect, it } from "vitest"
import { createServer } from "node:http"
import { AddressInfo } from "node:net"

import { startHttpServer, type AgentAdapterResolver } from "../http-server.js"
import { createSessionsRegistry } from "../sessions.js"
import type { AgentSessionLike, AgentStreamEvent } from "../sessions.js"
import { createRuntimeEvents } from "../events.js"
import type { ConversationStore } from "../conversations.js"
import type { HeartbeatRunner } from "../heartbeat.js"

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

function noopConversations(): ConversationStore {
  return {
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
}

function noopHeartbeat(): HeartbeatRunner {
  return {
    start() {},
    stop() {},
    async fireNow() {},
  }
}

async function mcpServerFactory() {
  const { createMcpServer } = await import("@agentproto/mcp-server")
  return (await createMcpServer({ specs: [], name: "main", version: "0" })).server
}

const resolveAgentAdapter: AgentAdapterResolver = async () => ({
  async startSession() {
    throw new Error("not used in this test")
  },
  commandPreview: "mock-adapter",
})

let acpCounter = 0
function fakeAgentSession(prefix: string): AgentSessionLike {
  return {
    sessionId: `${prefix}_${acpCounter++}`,
    // eslint-disable-next-line require-yield
    async *send(): AsyncIterable<AgentStreamEvent> {
      await new Promise(() => {}) // never resolves — keeps the session "running"
    },
    async cancel() {},
    async close() {},
  }
}

describe("GET /sessions — kind:\"command\" default-view exclusion", () => {
  let stopServer: (() => Promise<void>) | undefined

  afterEach(async () => {
    await stopServer?.()
    stopServer = undefined
  })

  async function withServer(
    run: (port: number, registry: ReturnType<typeof createSessionsRegistry>) => Promise<void>,
  ): Promise<void> {
    const registry = createSessionsRegistry({ persist: false })
    const port = await freePort()
    const http = await startHttpServer({
      port,
      auth: { mode: "none" },
      mcpServerFactory,
      conversations: noopConversations(),
      events: createRuntimeEvents(),
      heartbeat: noopHeartbeat(),
      sessions: registry,
      resolveAgentAdapter,
      meta: { workspace: process.cwd(), registered: [] },
    })
    stopServer = () => http.stop()
    try {
      await run(port, registry)
    } finally {
      await http.stop()
      stopServer = undefined
    }
  }

  it("excludes commands from the default (no ?kind) view", async () => {
    await withServer(async (port, registry) => {
      const agentDesc = registry.spawnAgent({
        workspaceSlug: "default",
        cwd: process.cwd(),
        agentSession: fakeAgentSession("agent"),
        adapterSlug: "fake",
      })
      const cmdDesc = registry.recordCommand({
        workspaceSlug: "default",
        cwd: process.cwd(),
        command: "pnpm",
        args: ["test"],
        exitCode: 0,
        signal: null,
        durationMs: 5,
        stdout: "",
        stderr: "",
      })

      const res = await fetch(`http://127.0.0.1:${port}/sessions`)
      expect(res.status).toBe(200)
      const body = (await res.json()) as { sessions: Array<{ id: string }> }
      const ids = body.sessions.map(s => s.id)
      expect(ids).toContain(agentDesc.id)
      expect(ids).not.toContain(cmdDesc.id)
    })
  })

  it("still returns commands with ?kind=command", async () => {
    await withServer(async (port, registry) => {
      registry.spawnAgent({
        workspaceSlug: "default",
        cwd: process.cwd(),
        agentSession: fakeAgentSession("agent"),
        adapterSlug: "fake",
      })
      const cmdDesc = registry.recordCommand({
        workspaceSlug: "default",
        cwd: process.cwd(),
        command: "pnpm",
        args: ["test"],
        exitCode: 0,
        signal: null,
        durationMs: 5,
        stdout: "",
        stderr: "",
      })

      const res = await fetch(`http://127.0.0.1:${port}/sessions?kind=command`)
      expect(res.status).toBe(200)
      const body = (await res.json()) as { sessions: Array<{ id: string }> }
      expect(body.sessions).toHaveLength(1)
      expect(body.sessions[0]?.id).toBe(cmdDesc.id)
    })
  })

  it("unions commands into the default view with ?includeCommands=true", async () => {
    await withServer(async (port, registry) => {
      const agentDesc = registry.spawnAgent({
        workspaceSlug: "default",
        cwd: process.cwd(),
        agentSession: fakeAgentSession("agent"),
        adapterSlug: "fake",
      })
      const cmdDesc = registry.recordCommand({
        workspaceSlug: "default",
        cwd: process.cwd(),
        command: "pnpm",
        args: ["test"],
        exitCode: 0,
        signal: null,
        durationMs: 5,
        stdout: "",
        stderr: "",
      })

      const res = await fetch(`http://127.0.0.1:${port}/sessions?includeCommands=true`)
      expect(res.status).toBe(200)
      const body = (await res.json()) as { sessions: Array<{ id: string }> }
      const ids = body.sessions.map(s => s.id)
      expect(ids).toContain(agentDesc.id)
      expect(ids).toContain(cmdDesc.id)
    })
  })
})
