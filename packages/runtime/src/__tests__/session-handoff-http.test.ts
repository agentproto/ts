/**
 * HTTP surface of the handoff verbs: `POST /sessions/:id/checkpoint` and
 * `POST /sessions/:id/handoff` (REST twins of `session_checkpoint` /
 * `session_continue_fresh`).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createServer } from "node:http"
import { AddressInfo } from "node:net"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createMcpServer } from "@agentproto/mcp-server"

import { startHttpServer, type AgentAdapterResolver } from "../http-server.js"
import { createSessionsRegistry } from "../sessions.js"
import type { AgentSessionLike, AgentStreamEvent, SessionDescriptor } from "../sessions.js"
import { createRuntimeEvents } from "../events.js"
import { setDefaultSessionsBaseDir } from "../transcript-writer.js"
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

const conversations: ConversationStore = {
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
const heartbeat: HeartbeatRunner = { start() {}, stop() {}, async fireNow() {} }

let counter = 0
function fakeAgentSession(): AgentSessionLike {
  return {
    sessionId: `acp_handoff_${++counter}`,
    // eslint-disable-next-line require-yield
    async *send(): AsyncIterable<AgentStreamEvent> {
      return
    },
    async cancel() {},
    async close() {},
  }
}

describe("POST /sessions/:id/checkpoint + /handoff", () => {
  let tmp: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "handoff-http-"))
    setDefaultSessionsBaseDir(tmp)
  })
  afterEach(() => {
    setDefaultSessionsBaseDir(undefined)
    rmSync(tmp, { recursive: true, force: true })
  })

  async function boot() {
    const registry = createSessionsRegistry({ persist: false, transcriptDir: tmp })
    const startSession = vi.fn(async () => fakeAgentSession())
    const resolveAgentAdapter: AgentAdapterResolver = async () => ({
      startSession,
      commandPreview: "mock-adapter",
    })
    const port = await freePort()
    const http = await startHttpServer({
      port,
      auth: { mode: "none" },
      mcpServerFactory: async () => (await createMcpServer({ specs: [], name: "t", version: "0" })).server,
      conversations,
      events: createRuntimeEvents(),
      heartbeat,
      sessions: registry,
      resolveAgentAdapter,
      meta: { workspace: process.cwd(), registered: [] },
    })
    const base = `http://127.0.0.1:${port}`
    const post = (path: string, body?: unknown) =>
      fetch(`${base}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body ?? {}),
      })
    const src = await post("/sessions/agent", { adapter: "claude-code", cwd: tmp })
    expect(src.status).toBe(201)
    const source = (await src.json()) as SessionDescriptor
    return {
      registry,
      startSession,
      post,
      source,
      stop: async () => {
        await http.stop()
        registry.shutdown()
      },
    }
  }

  it("checkpoint: 200 nominal — persists the file and returns {checkpointId, path, checkpoint}", async () => {
    const h = await boot()
    try {
      const res = await h.post(`/sessions/${h.source.id}/checkpoint`, { notes: "keep the migration" })
      expect(res.status).toBe(200)
      const body = (await res.json()) as {
        checkpointId: string
        path: string
        checkpoint: { checkpointId: string; sourceSessionId: string }
      }
      expect(body.checkpointId).toBe(body.checkpoint.checkpointId)
      expect(body.checkpoint.sourceSessionId).toBe(h.source.id)
      expect(body.path.startsWith(tmp)).toBe(true)
      expect(existsSync(body.path)).toBe(true)
      const onDisk = JSON.parse(readFileSync(body.path, "utf8")) as { sections: { notes?: string } }
      expect(onDisk.sections.notes).toBe("keep the migration")
    } finally {
      await h.stop()
    }
  })

  it("checkpoint: 404 unknown id, 400 invalid notes", async () => {
    const h = await boot()
    try {
      expect((await h.post("/sessions/sess_nope/checkpoint")).status).toBe(404)
      expect((await h.post(`/sessions/${h.source.id}/checkpoint`, { notes: 3 })).status).toBe(400)
    } finally {
      await h.stop()
    }
  })

  it("handoff: 201 nominal — spawns on the target harness, links provenance, carries notes", async () => {
    const h = await boot()
    try {
      const res = await h.post(`/sessions/${h.source.id}/handoff`, {
        to: "codex",
        model: "gpt-5",
        notes: "decision: keep zod",
      })
      expect(res.status).toBe(201)
      const body = (await res.json()) as {
        continuedFrom: string
        continuedTo: string
        checkpointId: string
        path: string
        handoff: { fromHarness: string; toHarness: string }
      }
      expect(body.continuedFrom).toBe(h.source.id)
      expect(body.handoff).toMatchObject({ fromHarness: "claude-code", toHarness: "codex" })
      expect(existsSync(body.path)).toBe(true)
      // source (1) + fresh (1)
      expect(h.startSession).toHaveBeenCalledTimes(2)
      const lastCall = h.startSession.mock.calls.at(-1) as unknown as [{ prompt?: string; model?: string }]
      expect(lastCall[0].model).toBe("gpt-5")
      expect(h.registry.get(h.source.id)?.continuedTo).toBe(body.continuedTo)
      expect(h.registry.get(body.continuedTo)?.continuedFrom).toBe(h.source.id)
    } finally {
      await h.stop()
    }
  })

  it("handoff: 404 unknown id, 400 missing/invalid body fields", async () => {
    const h = await boot()
    try {
      expect((await h.post("/sessions/sess_nope/handoff", { to: "codex" })).status).toBe(404)
      const missing = await h.post(`/sessions/${h.source.id}/handoff`, {})
      expect(missing.status).toBe(400)
      expect(await missing.json()).toMatchObject({ error: "to_required" })
      expect((await h.post(`/sessions/${h.source.id}/handoff`, { to: "codex", access: "x" })).status).toBe(400)
      expect((await h.post(`/sessions/${h.source.id}/handoff`, { to: "codex", dryRun: "yes" })).status).toBe(400)
      expect(h.startSession).toHaveBeenCalledTimes(1)
    } finally {
      await h.stop()
    }
  })

  it("handoff dryRun: returns the checkpoint + prompt with no spawn, no file, source untouched", async () => {
    const h = await boot()
    try {
      const before = h.registry.list().length
      const res = await h.post(`/sessions/${h.source.id}/handoff`, {
        to: "codex",
        notes: "dry-run note",
        dryRun: true,
      })
      expect(res.status).toBe(200)
      const body = (await res.json()) as {
        dryRun: boolean
        to: string
        prompt: string
        checkpoint: { checkpointPath: string; sourceSessionId: string }
      }
      expect(body.dryRun).toBe(true)
      expect(body.to).toBe("codex")
      expect(body.checkpoint.sourceSessionId).toBe(h.source.id)
      expect(body.prompt).toContain("[continued session")
      expect(body.prompt).toContain("dry-run note")

      expect(h.startSession).toHaveBeenCalledTimes(1)
      expect(h.registry.list().length).toBe(before)
      expect(existsSync(body.checkpoint.checkpointPath)).toBe(false)
      expect(existsSync(join(tmp, h.source.id, "checkpoints"))).toBe(false)
      const src = h.registry.get(h.source.id)
      expect(src?.continuedTo).toBeUndefined()
      expect(src?.checkpointId).toBeUndefined()
    } finally {
      await h.stop()
    }
  })

  it("handoff: an unresolvable target maps the spawn failure to its HTTP status", async () => {
    const registry = createSessionsRegistry({ persist: false, transcriptDir: tmp })
    let allowResolve = true
    const resolveAgentAdapter: AgentAdapterResolver = async () =>
      allowResolve ? { startSession: vi.fn(async () => fakeAgentSession()), commandPreview: "m" } : null
    const port = await freePort()
    const http = await startHttpServer({
      port,
      auth: { mode: "none" },
      mcpServerFactory: async () => (await createMcpServer({ specs: [], name: "t", version: "0" })).server,
      conversations,
      events: createRuntimeEvents(),
      heartbeat,
      sessions: registry,
      resolveAgentAdapter,
      meta: { workspace: process.cwd(), registered: [] },
    })
    const base = `http://127.0.0.1:${port}`
    const post = (path: string, body: unknown) =>
      fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
    try {
      const src = (await (await post("/sessions/agent", { adapter: "claude-code", cwd: tmp })).json()) as SessionDescriptor
      allowResolve = false
      const res = await post(`/sessions/${src.id}/handoff`, { to: "nope" })
      expect(res.status).toBe(404)
      expect(await res.json()).toMatchObject({ error: "adapter_not_found" })
    } finally {
      await http.stop()
      registry.shutdown()
    }
  })
})
