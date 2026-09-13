/**
 * WebSocket-level tests for the `/sessions/:id/pty` upgrade's `{kind:
 * "input"}` frame (http-server.ts's `handlePtyWebSocket`) — the third
 * bracketed-paste call site (FIX round 2), alongside the MCP
 * `terminal_input` tool and `POST /sessions/:id/terminal/input`. All three
 * now route through the shared `applyBracketedPasteWrap` helper in
 * sessions.ts, so this only needs to prove the WS frame actually calls it.
 */

import { describe, it, expect, afterEach } from "vitest"
import { createServer } from "node:http"
import { AddressInfo } from "node:net"
import WebSocket from "ws"

import { startHttpServer } from "../http-server.js"
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
    pid: 7780,
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

const BP_ON = "\x1b[?2004h"
const BP_OFF = "\x1b[?2004l"

let openSockets: WebSocket[] = []

function connectPty(port: number, sessionId: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/sessions/${sessionId}/pty?cols=80&rows=24`)
    openSockets.push(ws)
    ws.once("open", () => resolve(ws))
    ws.once("error", reject)
  })
}

function sendInput(ws: WebSocket, text: string): void {
  ws.send(JSON.stringify({ kind: "input", text }))
}

/** Poll `writes` until it reaches `count` entries or a timeout elapses —
 *  the WS frame → registry write is async relative to `ws.send`. */
async function waitForWrites(writes: string[], count: number, timeoutMs = 2000): Promise<void> {
  const start = Date.now()
  while (writes.length < count) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`timed out waiting for ${count} writes, got ${writes.length}: ${JSON.stringify(writes)}`)
    }
    await new Promise(r => setTimeout(r, 10))
  }
}

async function withPtyWsServer(
  run: (
    port: number,
    registry: SessionsRegistry,
    writes: string[],
    emitOutput: (chunk: string) => void,
  ) => Promise<void>,
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
        ws.close()
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
  for (const ws of openSockets) {
    try {
      ws.close()
    } catch {
      // ignore
    }
  }
  openSockets = []
})

describe("PTY WebSocket {kind:\"input\"} bracketed-paste wrap (FIX round 2)", () => {
  it("wraps multi-line `text` once the PTY has announced paste mode ON", async () => {
    await withPtyWsServer(async (port, registry, writes, emitOutput) => {
      const desc = registry.spawnPty({ workspaceSlug: "default", cwd: process.cwd(), argv: ["bash"], cols: 80, rows: 24 })
      emitOutput(BP_ON)
      const ws = await connectPty(port, desc.id)

      sendInput(ws, "line1\nline2")
      await waitForWrites(writes, 1)

      expect(writes).toEqual(["\x1b[200~line1\nline2\x1b[201~"])
    })
  })

  it("does not wrap single-line `text` even in paste mode ON", async () => {
    await withPtyWsServer(async (port, registry, writes, emitOutput) => {
      const desc = registry.spawnPty({ workspaceSlug: "default", cwd: process.cwd(), argv: ["bash"], cols: 80, rows: 24 })
      emitOutput(BP_ON)
      const ws = await connectPty(port, desc.id)

      sendInput(ws, "line1")
      await waitForWrites(writes, 1)

      expect(writes).toEqual(["line1"])
    })
  })

  it("does not wrap multi-line `text` before any paste-mode announcement (unknown)", async () => {
    await withPtyWsServer(async (port, registry, writes) => {
      const desc = registry.spawnPty({ workspaceSlug: "default", cwd: process.cwd(), argv: ["bash"], cols: 80, rows: 24 })
      const ws = await connectPty(port, desc.id)

      sendInput(ws, "line1\nline2")
      await waitForWrites(writes, 1)

      expect(writes).toEqual(["line1\nline2"])
    })
  })

  it("does not wrap multi-line `text` once paste mode has gone OFF again", async () => {
    await withPtyWsServer(async (port, registry, writes, emitOutput) => {
      const desc = registry.spawnPty({ workspaceSlug: "default", cwd: process.cwd(), argv: ["bash"], cols: 80, rows: 24 })
      emitOutput(BP_ON)
      emitOutput(BP_OFF)
      const ws = await connectPty(port, desc.id)

      sendInput(ws, "line1\nline2")
      await waitForWrites(writes, 1)

      expect(writes).toEqual(["line1\nline2"])
    })
  })
})
