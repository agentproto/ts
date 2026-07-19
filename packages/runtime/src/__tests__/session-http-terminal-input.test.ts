/**
 * HTTP-level tests for `POST /sessions/:id/terminal/input` (http-server.ts) —
 * the terminal-view reply path (FIX 2), sibling of `POST /sessions/:id/prompt`
 * which is agent-cli only. Mirrors the MCP `terminal_input` verb: writes
 * `text` verbatim, then a LONE `\r` (unless `enter:false`) in a second write.
 *
 * Covers the route's own contract: the `ptyEnabled` gate (501), 404 for an
 * unknown session, 400 for a session that isn't a live PTY, and the
 * text/enter write ordering on the happy path.
 */

import { describe, it, expect, vi } from "vitest"
import { createServer } from "node:http"
import { AddressInfo } from "node:net"

import { startHttpServer, type AgentAdapterResolver } from "../http-server.js"
import { createSessionsRegistry } from "../sessions.js"
import type {
  AgentSessionLike,
  AgentStreamEvent,
  PtyFactory,
  PtyProcess,
  SessionsRegistry,
} from "../sessions.js"
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

/** Fake PTY that records every `write` payload verbatim. */
function makeCapturingPtyFactory(writes: string[]): PtyFactory {
  return (): PtyProcess => ({
    pid: 7777,
    write: (data: string) => {
      writes.push(data)
    },
    resize: () => {},
    kill: () => {},
    onData: () => {},
    onExit: () => {},
  })
}

function fakeAgentSession(): AgentSessionLike {
  return {
    sessionId: "acp_ti_test",
    // eslint-disable-next-line require-yield
    async *send(): AsyncIterable<AgentStreamEvent> {
      return
    },
    async cancel() {},
    async close() {},
  }
}

async function withServer(
  ptyEnabled: boolean,
  run: (port: number, registry: SessionsRegistry, writes: string[]) => Promise<void>,
): Promise<void> {
  const writes: string[] = []
  const registry = createSessionsRegistry({
    persist: false,
    spawnPty: makeCapturingPtyFactory(writes),
  })
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
    ptyEnabled,
    meta: { workspace: process.cwd(), registered: [] },
  })
  try {
    await run(port, registry, writes)
  } finally {
    await http.stop()
    registry.shutdown()
  }
}

function postInput(port: number, id: string, body: unknown): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/sessions/${id}/terminal/input`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

describe("POST /sessions/:id/terminal/input", () => {
  it("writes text then a lone CR (default enter) and returns {ok:true}", async () => {
    await withServer(true, async (port, registry, writes) => {
      const desc = registry.spawnPty({ workspaceSlug: "default", cwd: process.cwd(), argv: ["bash"], cols: 80, rows: 24 })

      const res = await postInput(port, desc.id, { text: "hello" })

      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ ok: true })
      // Isolated-CR contract: content and Enter are DISTINCT writes in order.
      expect(writes).toEqual(["hello", "\r"])
    })
  })

  it("omits the CR when enter:false", async () => {
    await withServer(true, async (port, registry, writes) => {
      const desc = registry.spawnPty({ workspaceSlug: "default", cwd: process.cwd(), argv: ["bash"], cols: 80, rows: 24 })

      const res = await postInput(port, desc.id, { text: "hello", enter: false })

      expect(res.status).toBe(200)
      expect(writes).toEqual(["hello"])
    })
  })

  it("501s when pty support is not configured (ptyEnabled=false)", async () => {
    await withServer(false, async (port, registry, writes) => {
      const desc = registry.spawnPty({ workspaceSlug: "default", cwd: process.cwd(), argv: ["bash"], cols: 80, rows: 24 })

      const res = await postInput(port, desc.id, { text: "hello" })

      expect(res.status).toBe(501)
      expect(writes).toEqual([])
    })
  })

  it("404s for an unknown session id", async () => {
    await withServer(true, async (port, _registry, writes) => {
      const res = await postInput(port, "sess_missing", { text: "hello" })

      expect(res.status).toBe(404)
      expect(writes).toEqual([])
    })
  })

  it("400s when the session is not a live PTY (agent-cli session)", async () => {
    await withServer(true, async (port, registry, writes) => {
      const desc = registry.spawnAgent({
        workspaceSlug: "default",
        cwd: process.cwd(),
        adapterSlug: "mock",
        agentSession: fakeAgentSession(),
        commandPreview: "mock (agent)",
      })

      const res = await postInput(port, desc.id, { text: "hello" })

      expect(res.status).toBe(400)
      expect(writes).toEqual([])
    })
  })

  it("400s when `text` is missing", async () => {
    await withServer(true, async (port, registry, writes) => {
      const desc = registry.spawnPty({ workspaceSlug: "default", cwd: process.cwd(), argv: ["bash"], cols: 80, rows: 24 })

      const res = await postInput(port, desc.id, { enter: true })

      expect(res.status).toBe(400)
      expect(writes).toEqual([])
    })
  })
})
