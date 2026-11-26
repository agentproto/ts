/**
 * WebSocket-level tests for the `answers` parameter of `WS
 * /sessions/:id/pty` and for the backpressure rule: who answers the
 * terminal queries a PTY child sends, and that the one client expected to
 * answer never loses a chunk carrying them.
 */

import { describe, it, expect, afterEach } from "vitest"
import { createServer } from "node:http"
import { AddressInfo } from "node:net"
import WebSocket from "ws"

import {
  ptyClientAnswersQueries,
  PTY_WS_BACKPRESSURE_BYTES,
  shouldDropPtyFrame,
  startHttpServer,
} from "../http-server.js"
import { createSessionsRegistry } from "../sessions.js"
import type { PtyFactory, PtyProcess, SessionsRegistry } from "../sessions.js"
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

const resolveAgentAdapter = async () => {
  throw new Error("not used in this test")
}

/** Fake PTY that records `write` calls and exposes the `onData` handler
 *  sessions.ts registers, so a test can simulate the PTY announcing
 *  bracketed-paste mode from its OUTPUT stream before sending an `input`
 *  frame over the WS connection. */
function makeControllablePtyFactory(writes: string[]): {
  factory: PtyFactory
  emitOutput: (chunk: string) => void
} {
  let handler: ((data: string) => void) | undefined
  const factory: PtyFactory = (): PtyProcess => ({
    pid: 7781,
    write: (data: string) => {
      writes.push(data)
    },
    resize: () => {},
    kill: () => {},
    onData: h => {
      handler = h
    },
    onExit: () => {},
  })
  return { factory, emitOutput: chunk => handler?.(chunk) }
}

const ESC = "\x1b"
const DA1 = `${ESC}[c`
const DA1_REPLY = `${ESC}[?62;22c`

let openSockets: WebSocket[] = []

function connectPty(port: number, sessionId: string, params = ""): Promise<{ ws: WebSocket; received: () => string }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/sessions/${sessionId}/pty?cols=80&rows=24${params}`)
    openSockets.push(ws)
    let text = ""
    ws.on("message", raw => {
      const frame = JSON.parse(raw.toString("utf8")) as { kind: string; b64?: string }
      if (frame.kind === "data" && frame.b64) text += Buffer.from(frame.b64, "base64").toString("latin1")
    })
    ws.once("open", () => resolve({ ws, received: () => text }))
    ws.once("error", reject)
  })
}

async function waitFor(check: () => boolean, what: string, timeoutMs = 5000): Promise<void> {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`)
    await new Promise(r => setTimeout(r, 10))
  }
}

async function withPtyWsServer(
  run: (port: number, registry: SessionsRegistry, writes: string[], emitOutput: (chunk: string) => void) => Promise<void>,
): Promise<void> {
  const writes: string[] = []
  const { factory, emitOutput } = makeControllablePtyFactory(writes)
  const registry = createSessionsRegistry({ persist: false, spawnPty: factory })
  const port = await freePort()
  const http = await startHttpServer({
    port,
    auth: { mode: "none" },
    mcpServerFactory,
    conversations: noopConversations(),
    events: createRuntimeEvents(),
    heartbeat: noopHeartbeat(),
    sessions: registry,
    resolveAgentAdapter: resolveAgentAdapter as never,
    ptyEnabled: true,
    meta: { workspace: process.cwd(), registered: [] },
  })
  try {
    await run(port, registry, writes, emitOutput)
  } finally {
    for (const ws of openSockets) {
      try {
        ws.terminate()
      } catch {
        // ignore
      }
    }
    openSockets = []
    await http.stop()
    registry.shutdown()
  }
}

afterEach(() => {
  openSockets = []
})

const spawn = (registry: SessionsRegistry) =>
  registry.spawnPty({ workspaceSlug: "default", cwd: process.cwd(), argv: ["claude"], cols: 80, rows: 24 })

describe("ptyClientAnswersQueries / shouldDropPtyFrame", () => {
  it("only the literal answers=0 opts a client out", () => {
    expect(ptyClientAnswersQueries(null)).toBe(true)
    expect(ptyClientAnswersQueries("1")).toBe(true)
    expect(ptyClientAnswersQueries("false")).toBe(true)
    expect(ptyClientAnswersQueries("")).toBe(true)
    expect(ptyClientAnswersQueries("0")).toBe(false)
  })

  it("drops frames past the threshold, never one carrying queries", () => {
    expect(shouldDropPtyFrame(PTY_WS_BACKPRESSURE_BYTES, false)).toBe(false)
    expect(shouldDropPtyFrame(PTY_WS_BACKPRESSURE_BYTES + 1, false)).toBe(true)
    expect(shouldDropPtyFrame(PTY_WS_BACKPRESSURE_BYTES + 1, true)).toBe(false)
  })
})

describe("WS /sessions/:id/pty ?answers=", () => {
  for (const [name, params] of [
    ["no parameter", ""],
    ["answers=1", "&answers=1"],
  ] as const) {
    it(`${name}: the client receives the query and the daemon stays silent`, async () => {
      await withPtyWsServer(async (port, registry, writes, emitOutput) => {
        const desc = spawn(registry)
        const client = await connectPty(port, desc.id, params)
        emitOutput(`hi${DA1}`)
        await waitFor(() => client.received().includes(DA1), "the query on the client")
        expect(writes).toEqual([])
      })
    })
  }

  it("answers=0: the client gets no query and the daemon answers", async () => {
    await withPtyWsServer(async (port, registry, writes, emitOutput) => {
      const desc = spawn(registry)
      const client = await connectPty(port, desc.id, "&answers=0")
      emitOutput(`hi${DA1}done`)
      await waitFor(() => client.received().includes("done"), "the output on the client")
      expect(client.received()).toBe("hidone")
      expect(writes).toEqual([DA1_REPLY])
    })
  })

  it("a saturated answering client still receives the chunk carrying a query", async () => {
    await withPtyWsServer(async (port, registry, writes, emitOutput) => {
      const desc = spawn(registry)
      const client = await connectPty(port, desc.id)
      // Stop reading on the client so the daemon's send queue fills up.
      const socket = (client.ws as unknown as { _socket: { pause(): void; resume(): void } })._socket
      socket.pause()
      const filler = "x".repeat(256 * 1024)
      const fillerChunks = 64 // 16 MiB: far beyond the kernel buffers
      for (let i = 0; i < fillerChunks; i++) emitOutput(filler)
      emitOutput(`ask${DA1}`)
      socket.resume()
      await waitFor(() => client.received().includes(`ask${DA1}`), "the query chunk", 20_000)
      // Saturation was real: some filler was dropped, the query was not.
      expect(client.received().length).toBeLessThan(fillerChunks * filler.length)
      expect(writes).toEqual([])
    })
  }, 30_000)
})
