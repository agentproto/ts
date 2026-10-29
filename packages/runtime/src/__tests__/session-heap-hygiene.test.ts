/**
 * E91 heap hygiene: `availableCommands` is a LIVE-only field (never persisted,
 * never reloaded onto a ghost, not in the default `GET /sessions` list), and a
 * terminal session's output rings are dropped once its final text has been
 * captured — while `agent_output` still answers with that final text.
 */

import { afterEach, describe, expect, it } from "vitest"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { createMcpServer } from "@agentproto/mcp-server"

import { registerAgentTools } from "../agent-tools.js"
import { registerSessionTools } from "../session-tools.js"
import { startHttpServer, type AgentAdapterResolver } from "../http-server.js"
import {
  createSessionsRegistry,
  type AgentSessionLike,
  type AgentStreamEvent,
  type SessionsRegistry,
} from "../sessions.js"
import { createRuntimeEvents } from "../events.js"
import type { ConversationStore } from "../conversations.js"
import type { HeartbeatRunner } from "../heartbeat.js"

const COMMANDS = Array.from({ length: 30 }, (_, k) => ({
  name: `cmd${k}`,
  description: "x".repeat(400),
}))

function fakeAgentSession(prefix: string): AgentSessionLike {
  return {
    sessionId: `${prefix}_${Math.random().toString(36).slice(2)}`,
    async *send(): AsyncIterable<AgentStreamEvent> {
      await new Promise(() => {})
    },
    async cancel() {},
    async close() {},
  }
}

async function buildToolHarness(
  registry: SessionsRegistry,
): Promise<{ client: Client; close: () => Promise<void> }> {
  const { server } = await createMcpServer({ specs: [], name: "test", version: "0" })
  registerAgentTools(server, { registry })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: "test-client", version: "0" })
  await client.connect(clientTransport)
  return { client, close: () => client.close() }
}

async function buildTerminalToolHarness(
  registry: SessionsRegistry,
): Promise<{ client: Client; close: () => Promise<void> }> {
  const { server } = await createMcpServer({ specs: [], name: "test", version: "0" })
  registerSessionTools(server, { registry, workspace: process.cwd(), ptyEnabled: true })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: "test-client", version: "0" })
  await client.connect(clientTransport)
  return { client, close: () => client.close() }
}

function textOf(result: unknown): string {
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content
  return content?.find(c => c.type === "text")?.text ?? ""
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
  return { start() {}, stop() {}, async fireNow() {} }
}

async function mcpServerFactory() {
  const { createMcpServer: create } = await import("@agentproto/mcp-server")
  return (await create({ specs: [], name: "main", version: "0" })).server
}

const resolveAgentAdapter: AgentAdapterResolver = async () => ({
  async startSession() {
    throw new Error("not used in this test")
  },
  commandPreview: "mock-adapter",
})

describe("availableCommands is live-only", () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  it("is stripped from the persisted snapshot and not reloaded onto ghosts", async () => {
    const dir = mkdtempSync(join(tmpdir(), "e91-commands-persist-"))
    dirs.push(dir)
    const persistPath = join(dir, "sessions.json")
    const registry = createSessionsRegistry({ persistPath })
    const desc = registry.spawnAgent({
      workspaceSlug: "default",
      cwd: dir,
      agentSession: fakeAgentSession("ghost"),
      adapterSlug: "fake",
    })
    desc.availableCommands = COMMANDS
    registry.shutdown()

    const raw = readFileSync(persistPath, "utf8")
    expect(raw).not.toContain("availableCommands")
    const snapshot = JSON.parse(raw) as { sessions: Array<Record<string, unknown>> }
    expect(snapshot.sessions[0]?.availableCommands).toBeUndefined()

    const reloaded = createSessionsRegistry({ persistPath })
    try {
      const ghost = reloaded.list({ includeArchived: true })[0]
      expect(ghost?.id).toBe(desc.id)
      expect(ghost).not.toHaveProperty("availableCommands")
    } finally {
      reloaded.shutdown()
    }
  })

  it("is omitted from the default GET /sessions list, still served via ?fields=", async () => {
    const dir = mkdtempSync(join(tmpdir(), "e91-commands-http-"))
    dirs.push(dir)
    const registry = createSessionsRegistry({ persistPath: join(dir, "sessions.json"), persist: false })
    // 200 wide rows: 30 commands x 400 chars each, like the real daemon's max row.
    for (let i = 0; i < 200; i++) {
      const desc = registry.spawnAgent({
        workspaceSlug: "default",
        cwd: dir,
        agentSession: fakeAgentSession(`wide-${i}`),
        adapterSlug: "fake",
      })
      desc.availableCommands = COMMANDS
    }
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
    try {
      const res = await fetch(`http://127.0.0.1:${port}/sessions`)
      expect(res.status).toBe(200)
      const text = await res.text()
      expect(text.length).toBeLessThan(2_000_000)
      const body = JSON.parse(text) as { sessions: Array<Record<string, unknown>> }
      expect(body.sessions.length).toBe(200)
      for (const row of body.sessions) expect(row).not.toHaveProperty("availableCommands")

      const explicit = await fetch(
        `http://127.0.0.1:${port}/sessions?fields=availableCommands&limit=1`,
      )
      expect(explicit.status).toBe(200)
      const explicitBody = (await explicit.json()) as {
        sessions: Array<{ availableCommands?: unknown[] }>
      }
      expect(explicitBody.sessions[0]?.availableCommands).toHaveLength(30)

      // The `?since=` delta view uses the same default projection.
      const delta = await fetch(
        `http://127.0.0.1:${port}/sessions?since=1970-01-01T00:00:00.000Z`,
      )
      expect(delta.status).toBe(200)
      const deltaBody = (await delta.json()) as {
        sessions: Array<Record<string, unknown>>
      }
      expect(deltaBody.sessions.length).toBe(200)
      for (const row of deltaBody.sessions) {
        expect(row).not.toHaveProperty("availableCommands")
      }
    } finally {
      await http.stop()
      registry.shutdown()
    }
  })
})

describe("output rings of a finished session", () => {
  it("are cleared on kill, so attach replays nothing, but agent_output still returns the final text", async () => {
    const dir = mkdtempSync(join(tmpdir(), "e91-rings-"))
    try {
      const registry = createSessionsRegistry({
        persistPath: join(dir, "sessions.json"),
        transcriptDir: join(dir, "sessions"),
        persist: false,
      })
      const fakeAgent: AgentSessionLike = {
        sessionId: "acp-rings-1",
        async *send(): AsyncIterable<AgentStreamEvent> {
          for (let i = 0; i < 600; i++) {
            yield { kind: "text-delta", text: `line ${i}\n` }
          }
          yield { kind: "text-delta", text: "FINAL EXECUTOR RESULT\n" }
          yield { kind: "turn-end", reason: "completed" }
        },
        async cancel() {},
        async close() {},
      }
      const desc = registry.spawnAgent({
        workspaceSlug: "default",
        cwd: dir,
        agentSession: fakeAgent,
        adapterSlug: "fake",
        initialPrompt: "go",
      })

      // Let the turn drain into the ring (which caps at 500 lines).
      for (let i = 0; i < 40 && (registry.get(desc.id)?.busy ?? false); i++) {
        await new Promise(r => setTimeout(r, 10))
      }
      const before: string[] = []
      const beforeUnsub = registry.attach(desc.id, line => before.push(line))
      beforeUnsub?.()
      expect(before).toHaveLength(500)

      expect(registry.kill(desc.id, "SIGTERM", "operator-stopped")).toBe(true)

      const after: string[] = []
      const afterUnsub = registry.attach(desc.id, line => after.push(line))
      afterUnsub?.()
      expect(after).toEqual([])

      const harness = await buildToolHarness(registry)
      try {
        const result = await harness.client.callTool({
          name: "agent_output",
          arguments: { sessionId: desc.id, lastN: 10 },
        })
        const payload = JSON.parse(textOf(result)) as { lines?: string[] }
        expect(payload.lines?.join("\n")).toContain("FINAL EXECUTOR RESULT")
      } finally {
        await harness.close()
      }
      registry.shutdown()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("keeps a finished PTY's scrollback readable from terminal_output and /preview", async () => {
    const dir = mkdtempSync(join(tmpdir(), "e91-pty-rings-"))
    let feed: ((chunk: string) => void) | undefined
    let exit: ((evt: { exitCode: number; signal?: number }) => void) | undefined
    const registry = createSessionsRegistry({
      persistPath: join(dir, "sessions.json"),
      transcriptDir: join(dir, "sessions"),
      persist: false,
      spawnPty: () => ({
        pid: process.pid,
        write() {},
        resize() {},
        kill() {},
        onData(cb) {
          feed = cb
        },
        onExit(cb) {
          exit = cb
        },
      }),
    })
    try {
      const desc = registry.spawnPty({
        workspaceSlug: "default",
        cwd: dir,
        argv: ["bash"],
        cols: 80,
        rows: 24,
      })
      feed?.("hello from pty\nFINAL PTY LINE\n")
      exit?.({ exitCode: 0 })
      // Let the writer flush terminal.jsonl before reading it back.
      await new Promise(r => setTimeout(r, 50))

      const harness = await buildTerminalToolHarness(registry)
      try {
        const result = await harness.client.callTool({
          name: "terminal_output",
          arguments: { sessionId: desc.id, clean: true },
        })
        const payload = JSON.parse(textOf(result)) as { text?: string }
        expect(payload.text).toContain("FINAL PTY LINE")
      } finally {
        await harness.close()
      }

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
      try {
        const res = await fetch(`http://127.0.0.1:${port}/sessions/${desc.id}/preview`)
        expect(res.status).toBe(200)
        const body = (await res.json()) as { bytes: string | null }
        expect(body.bytes).not.toBeNull()
        expect(Buffer.from(body.bytes ?? "", "base64").toString("utf8")).toContain(
          "FINAL PTY LINE",
        )
      } finally {
        await http.stop()
        registry.shutdown()
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("serves the final text, never a late line appended after the terminal clear", async () => {
    const dir = mkdtempSync(join(tmpdir(), "e91-race-"))
    let release: () => void = () => {}
    const gate = new Promise<void>(resolve => {
      release = resolve
    })
    const registry = createSessionsRegistry({
      persist: false,
      transcriptDir: join(dir, "sessions"),
    })
    try {
      const fakeAgent: AgentSessionLike = {
        sessionId: "acp-race-1",
        async *send(): AsyncIterable<AgentStreamEvent> {
          yield { kind: "text-delta", text: "FINAL RESULT\n" }
          await gate
          yield { kind: "text-delta", text: "LATE AFTER KILL\n" }
        },
        async cancel() {},
        async close() {},
      }
      const desc = registry.spawnAgent({
        workspaceSlug: "default",
        cwd: dir,
        agentSession: fakeAgent,
        adapterSlug: "fake",
        initialPrompt: "go",
      })
      for (let i = 0; i < 40; i++) {
        if (registry.readOutputTail(desc.id, 10).some(l => l.includes("FINAL RESULT"))) break
        await new Promise(r => setTimeout(r, 10))
      }

      expect(registry.kill(desc.id, "SIGTERM", "operator-stopped")).toBe(true)
      release()

      // Prove the race happened: the straggler landed in the ring after the
      // terminal clear.
      let lateInRing = false
      for (let i = 0; i < 40; i++) {
        const ring: string[] = []
        registry.attach(desc.id, line => ring.push(line))?.()
        if (ring.some(l => l.includes("LATE AFTER KILL"))) {
          lateInRing = true
          break
        }
        await new Promise(r => setTimeout(r, 10))
      }
      expect(lateInRing).toBe(true)

      const tail = registry.readOutputTail(desc.id, 10).join("\n")
      expect(tail).toContain("FINAL RESULT")
      expect(tail).not.toContain("LATE AFTER KILL")
    } finally {
      registry.shutdown()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
