/**
 * `POST /sessions/:id/checkpoint` called by the projected PreCompact hook
 * (`agentproto hook pre-compact`): `reason: "native-pre-compact"` never asks
 * the source session for a handoff turn (it is busy inside its own
 * compaction), the reason lands in the checkpoint's notice line, and a
 * repeated `occurrenceId` answers the first checkpoint instead of building
 * another. A body without the new fields behaves as before.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { createServer } from "node:http"
import { AddressInfo } from "node:net"
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { createMcpServer } from "@agentproto/mcp-server"

import type { ConversationStore } from "../conversations.js"
import { createRuntimeEvents } from "../events.js"
import type { HeartbeatRunner } from "../heartbeat.js"
import { startHttpServer, type AgentAdapterResolver } from "../http-server.js"
import {
  createSessionEventBus,
  type SessionContextCompactedEvent,
} from "../session-event-bus.js"
import {
  createSessionsRegistry,
  type AgentSessionLike,
  type AgentStreamEvent,
  type SessionDescriptor,
} from "../sessions.js"
import { setDefaultSessionsBaseDir } from "../transcript-writer.js"

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

/** A source session that records every prompt it receives. The usage frames
 *  of each turn come from `turns` (the last one repeats). */
function recordingSession(turns: number[][]): AgentSessionLike & { prompts: string[] } {
  const queue = [...turns]
  let last: number[] = []
  const s = {
    sessionId: "acp-pre-compact",
    prompts: [] as string[],
    async *send(message: unknown): AsyncIterable<AgentStreamEvent> {
      const text = (Array.isArray(message) ? message : [message])
        .map(b => (typeof b === "string" ? b : ((b as { text?: string } | undefined)?.text ?? "")))
        .join("")
      s.prompts.push(text)
      const frames = queue.shift() ?? last
      last = frames
      yield { kind: "text-delta", text: "ok" }
      for (const used of frames) yield { kind: "usage_update", size: 200_000, used }
      yield { kind: "turn-end" }
    },
    async cancel() {},
    async close() {},
  }
  return s
}

interface CheckpointBody {
  ok?: boolean
  checkpointId: string
  path: string
  deduped?: boolean
  checkpoint: { checkpointId: string; handoffTurn?: { status: string; reason?: string } }
}

describe("R1 POST /sessions/:id/checkpoint for the native pre-compact hook", () => {
  let tmp: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "pre-compact-route-"))
    setDefaultSessionsBaseDir(tmp)
  })
  afterEach(() => {
    setDefaultSessionsBaseDir(undefined)
    rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  })

  async function boot(turns: number[][] = [[1_000]]) {
    const bus = createSessionEventBus()
    const compactions: SessionContextCompactedEvent[] = []
    bus.onAny(ev => {
      if ((ev.type as string) === "agentproto:context-compacted") compactions.push(ev as SessionContextCompactedEvent)
    })
    const registry = createSessionsRegistry({ persist: false, transcriptDir: tmp, sessionEvents: bus })
    const source = recordingSession(turns)
    const resolveAgentAdapter: AgentAdapterResolver = async () => ({
      startSession: async () => source,
      commandPreview: "fake",
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
    const res = await post("/sessions/agent", { adapter: "claude-code", cwd: tmp })
    expect(res.status).toBe(201)
    const { id } = (await res.json()) as SessionDescriptor
    const outputOf = (): string[] => {
      const lines: string[] = []
      registry.attach(id, line => lines.push(line))?.()
      return lines
    }
    return {
      id,
      registry,
      source,
      compactions,
      post,
      outputOf,
      stop: async () => {
        await http.stop()
        registry.shutdown()
        // shutdown() starts transcript-stream closes it cannot await; drain them
        // before afterEach removes the dir (else ENOTEMPTY on the sess_* rmdir).
        await registry.settlePendingWrites()
      },
    }
  }

  const native = (occurrenceId: string) => ({ reason: "native-pre-compact", occurrenceId, trigger: "auto" })

  it("builds without asking the source session and names the reason in the notice line", async () => {
    const h = await boot()
    try {
      await h.registry.sendPrompt(h.id, "work")
      const promptsBefore = h.source.prompts.length
      const res = await h.post(`/sessions/${h.id}/checkpoint`, native("pc-100"))
      expect(res.status).toBe(200)
      const body = (await res.json()) as CheckpointBody
      expect(body.ok).toBe(true)
      expect(body.deduped).toBeUndefined()
      expect(existsSync(body.path)).toBe(true)
      expect(body.checkpoint.handoffTurn).toEqual({ status: "skipped", reason: "askSource disabled" })
      expect(h.source.prompts.length).toBe(promptsBefore)
      expect(h.outputOf().filter(l => l.includes(`checkpoint ${body.checkpointId}`))).toEqual([
        `[context] checkpoint ${body.checkpointId} written to ${body.path} before native-pre-compact (auto)`,
      ])
    } finally {
      await h.stop()
    }
  })

  it("the same occurrenceId answers the first checkpoint (deduped) and writes no second file; a new one writes", async () => {
    const h = await boot()
    try {
      const first = (await (await h.post(`/sessions/${h.id}/checkpoint`, native("pc-200"))).json()) as CheckpointBody
      const again = await h.post(`/sessions/${h.id}/checkpoint`, native("pc-200"))
      expect(again.status).toBe(200)
      const second = (await again.json()) as CheckpointBody
      expect(second).toMatchObject({ ok: true, deduped: true, checkpointId: first.checkpointId, path: first.path })
      expect(second.checkpoint.checkpointId).toBe(first.checkpointId)
      expect(readdirSync(dirname(first.path))).toHaveLength(1)

      const other = (await (await h.post(`/sessions/${h.id}/checkpoint`, native("pc-300"))).json()) as CheckpointBody
      expect(other.deduped).toBeUndefined()
      expect(other.checkpointId).not.toBe(first.checkpointId)
      expect(readdirSync(dirname(first.path))).toHaveLength(2)
    } finally {
      await h.stop()
    }
  })

  it("refuses an invalid reason, occurrenceId or trigger with 400", async () => {
    const h = await boot()
    try {
      const url = `/sessions/${h.id}/checkpoint`
      expect((await h.post(url, { reason: 3 })).status).toBe(400)
      expect((await h.post(url, { reason: "r".repeat(65) })).status).toBe(400)
      expect((await h.post(url, { reason: "native-pre-compact", occurrenceId: "a/b" })).status).toBe(400)
      expect((await h.post(url, { reason: "native-pre-compact", occurrenceId: "a b" })).status).toBe(400)
      expect((await h.post(url, { reason: "native-pre-compact", occurrenceId: "" })).status).toBe(400)
      expect((await h.post(url, { reason: "native-pre-compact", occurrenceId: "x".repeat(129) })).status).toBe(400)
      expect((await h.post(url, { reason: "native-pre-compact", occurrenceId: 12 })).status).toBe(400)
      expect((await h.post(url, { reason: "native-pre-compact", occurrenceId: "pc-1", trigger: "later" })).status).toBe(400)
      expect(existsSync(join(tmp, h.id, "checkpoints"))).toBe(false)
    } finally {
      await h.stop()
    }
  })

  it("refuses a reason that could forge a transcript line or an escape sequence", async () => {
    const h = await boot()
    try {
      const url = `/sessions/${h.id}/checkpoint`
      for (const reason of ["", " ", "a\nb", "native\r\n[context] forged", "x\u001b[31mred", "tab\there", "a\u0000b", "-leading-dash"]) {
        const res = await h.post(url, { reason })
        expect({ reason, status: res.status }).toEqual({ reason, status: 400 })
      }
      expect(existsSync(join(tmp, h.id, "checkpoints"))).toBe(false)
      expect(h.outputOf().filter(l => l.includes("[context] checkpoint"))).toEqual([])
      // Plain words, digits and ". _ : -" stay valid.
      expect((await h.post(url, { reason: "manual run: v1.2" })).status).toBe(200)
    } finally {
      await h.stop()
    }
  })

  it("two concurrent requests with the same occurrenceId build one checkpoint", async () => {
    const h = await boot()
    try {
      const url = `/sessions/${h.id}/checkpoint`
      const [a, b, c] = await Promise.all([
        h.post(url, native("pc-500")),
        h.post(url, native("pc-500")),
        h.post(url, native("pc-500")),
      ])
      const bodies = (await Promise.all([a, b, c].map(r => r.json()))) as CheckpointBody[]
      expect([a.status, b.status, c.status]).toEqual([200, 200, 200])
      expect(new Set(bodies.map(x => x.checkpointId)).size).toBe(1)
      expect(bodies.filter(x => x.deduped === true)).toHaveLength(2)
      expect(readdirSync(dirname(bodies[0]!.path))).toHaveLength(1)
      expect(h.outputOf().filter(l => l.includes("[context] checkpoint"))).toHaveLength(1)
    } finally {
      await h.stop()
    }
  })

  it("the trigger is part of the notice line, and absent without it", async () => {
    const h = await boot()
    try {
      const manual = (await (await h.post(`/sessions/${h.id}/checkpoint`, { reason: "native-pre-compact", occurrenceId: "pc-600", trigger: "manual" })).json()) as CheckpointBody
      const bare = (await (await h.post(`/sessions/${h.id}/checkpoint`, { reason: "native-pre-compact", occurrenceId: "pc-601" })).json()) as CheckpointBody
      const lines = h.outputOf()
      expect(lines).toContain(`[context] checkpoint ${manual.checkpointId} written to ${manual.path} before native-pre-compact (manual)`)
      expect(lines).toContain(`[context] checkpoint ${bare.checkpointId} written to ${bare.path} before native-pre-compact`)
    } finally {
      await h.stop()
    }
  })

  it("a body without the new fields is unchanged: no dedupe, no notice line", async () => {
    const h = await boot()
    try {
      const a = (await (await h.post(`/sessions/${h.id}/checkpoint`, {})).json()) as CheckpointBody
      const b = (await (await h.post(`/sessions/${h.id}/checkpoint`, {})).json()) as CheckpointBody
      expect(a.deduped).toBeUndefined()
      expect(b.deduped).toBeUndefined()
      expect(a.checkpointId).not.toBe(b.checkpointId)
      expect(h.outputOf().filter(l => l.includes("[context] checkpoint"))).toEqual([])
    } finally {
      await h.stop()
    }
  })

  it("a native drop right after the hook's checkpoint is guarded", async () => {
    const h = await boot([[150_000], [30_000]])
    try {
      await h.registry.sendPrompt(h.id, "work")
      expect((await h.post(`/sessions/${h.id}/checkpoint`, native("pc-400"))).status).toBe(200)
      await h.registry.sendPrompt(h.id, "more")
      expect(h.compactions).toHaveLength(1)
      expect(h.compactions[0]!.guarded).toBe(true)
    } finally {
      await h.stop()
    }
  })
})
