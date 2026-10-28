/**
 * A harness that compacts its own context (claude-code, codex) does it
 * without a `/compact` prompt, so the daemon's "no checkpoint, no
 * compaction" gate never sees it. The runtime observes it passively: a
 * usage drop between two accepted samples is reported once as
 * `agentproto:context-compacted`, with a greppable transcript line, and
 * `guarded` says whether a checkpoint was written shortly before.
 *
 * Drops the daemon or the operator caused (a `/compact` turn, the floor
 * rescue) and readings that are not a drop (the first frame, a frame past
 * the window, the first frame after a resume, a window change) are not
 * reported.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createServer } from "node:http"
import { AddressInfo } from "node:net"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createMcpServer } from "@agentproto/mcp-server"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import type { RoutineFrontmatter } from "@agentproto/routine"

import {
  HOST_EVENT_REGISTRATIONS,
  resolveRoutineEventBinding,
} from "../action-hooks/event-bindings.js"
import {
  CONTEXT_CONTINUITY_DEFAULTS,
  type ResolvedContextContinuityPolicy,
} from "../context-continuity.js"
import type { ConversationStore } from "../conversations.js"
import { createRuntimeEvents } from "../events.js"
import type { HeartbeatRunner } from "../heartbeat.js"
import { startHttpServer, type AgentAdapterResolver } from "../http-server.js"
import {
  createSessionEventBus,
  type SessionContextCompactedEvent,
  type SessionEventBus,
} from "../session-event-bus.js"
import {
  createSessionsRegistry,
  type AgentSessionLike,
  type AgentStreamEvent,
  type SessionDescriptor,
  type SessionsRegistry,
} from "../sessions.js"
import { registerSessionTools } from "../session-tools.js"
import { setDefaultSessionsBaseDir } from "../transcript-writer.js"

const EVENT = "agentproto:context-compacted"

interface Harness extends AgentSessionLike {
  prompts: string[]
  /** Push one event the way an adapter does with no prompt in flight. */
  emitOutOfTurn(evt: AgentStreamEvent): void
}

interface HarnessOpts {
  /** `used` of every usage frame, one array per turn; the last one repeats. */
  turns: number[][]
  size: number
  /** Frames of a `/compact` turn (default: one frame at 1000). */
  compactFrames?: number[]
  /** Advertise `/compact` as a slash command, the way real adapters do. */
  advertiseCommand?: boolean
}

function harness(o: HarnessOpts): Harness {
  const turns = [...o.turns]
  let last: number[] = []
  let advertised = !(o.advertiseCommand ?? false)
  const listeners = new Set<(evt: AgentStreamEvent) => void>()
  const h: Harness = {
    sessionId: "acp-native",
    prompts: [],
    availableModes: [],
    async *send(message): AsyncIterable<AgentStreamEvent> {
      const text = (Array.isArray(message) ? message : [message])
        .map(b => (typeof b === "string" ? b : ((b as { text?: string } | undefined)?.text ?? "")))
        .join("")
      h.prompts.push(text)
      if (!advertised) {
        advertised = true
        yield { kind: "available-commands", commands: [{ name: "compact", description: "Compact the conversation" }] }
      }
      let frames: number[]
      if (text.startsWith("/compact") || text.startsWith("/compress")) {
        frames = o.compactFrames ?? [1_000]
      } else {
        frames = turns.shift() ?? last
        last = frames
      }
      yield { kind: "text-delta", text: "ok" }
      for (const used of frames) yield { kind: "usage_update", size: o.size, used }
      yield { kind: "turn-end" }
    },
    onOutOfTurnEvent(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    emitOutOfTurn(evt) {
      for (const l of listeners) l(evt)
    },
    async cancel() {},
    async close() {},
  }
  return h
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

function captureCompactions(bus: SessionEventBus): SessionContextCompactedEvent[] {
  const got: SessionContextCompactedEvent[] = []
  bus.onAny(ev => {
    if ((ev.type as string) === EVENT) got.push(ev as SessionContextCompactedEvent)
  })
  return got
}

describe("D1: detectNativeCompaction", () => {
  const load = () => import("../native-compaction.js")

  it("detects a real drop with the right numbers", async () => {
    const { detectNativeCompaction } = await load()
    expect(detectNativeCompaction({ used: 150_000, size: 200_000 }, { used: 30_000, size: 200_000 })).toEqual({
      usedBefore: 150_000,
      usedAfter: 30_000,
      ratio: 0.2,
    })
  })

  it("needs a previous sample", async () => {
    const { detectNativeCompaction } = await load()
    expect(detectNativeCompaction(undefined, { used: 30_000, size: 200_000 })).toBeUndefined()
  })

  it("ignores a drop from below minBefore", async () => {
    const { detectNativeCompaction } = await load()
    expect(detectNativeCompaction({ used: 29_999 }, { used: 1_000 })).toBeUndefined()
  })

  it("ignores a drop under minDrop", async () => {
    const { detectNativeCompaction } = await load()
    // ratio 0.4 is fine, the drop (19 999) is not
    expect(detectNativeCompaction({ used: 33_332 }, { used: 13_333 })).toBeUndefined()
  })

  it("ignores a ratio above maxRatio", async () => {
    const { detectNativeCompaction } = await load()
    expect(detectNativeCompaction({ used: 150_000 }, { used: 90_000 })).toBeUndefined()
  })

  it("ignores a window change (size known on both and different)", async () => {
    const { detectNativeCompaction } = await load()
    expect(
      detectNativeCompaction({ used: 150_000, size: 200_000 }, { used: 30_000, size: 1_000_000 }),
    ).toBeUndefined()
    // an unknown size on one side is not a window change
    expect(detectNativeCompaction({ used: 150_000 }, { used: 30_000, size: 200_000 })).toBeDefined()
  })

  it("ignores a rising reading", async () => {
    const { detectNativeCompaction } = await load()
    expect(detectNativeCompaction({ used: 30_000, size: 200_000 }, { used: 150_000, size: 200_000 })).toBeUndefined()
  })

  it("holds the exact boundaries of its constants", async () => {
    const { detectNativeCompaction, NATIVE_COMPACTION_DEFAULTS } = await load()
    expect(NATIVE_COMPACTION_DEFAULTS).toEqual({ minBefore: 30_000, maxRatio: 0.5, minDrop: 20_000 })
    // minBefore: 30 000 is inside, 29 999 outside (ratio and drop both fine)
    expect(detectNativeCompaction({ used: 30_000 }, { used: 0 + 1 })).toBeDefined()
    expect(detectNativeCompaction({ used: 29_999 }, { used: 1 })).toBeUndefined()
    // maxRatio: exactly 0.5 is inside, just above is outside
    expect(detectNativeCompaction({ used: 100_000 }, { used: 50_000 })).toBeDefined()
    expect(detectNativeCompaction({ used: 100_000 }, { used: 50_001 })).toBeUndefined()
    // minDrop: exactly 20 000 is inside, 19 999 outside (ratio under 0.5 both times)
    expect(detectNativeCompaction({ used: 40_000 }, { used: 20_000 })).toBeDefined()
    expect(detectNativeCompaction({ used: 39_999 }, { used: 20_000 })).toBeUndefined()
    // the options override the defaults
    expect(detectNativeCompaction({ used: 100_000 }, { used: 60_000 }, { maxRatio: 0.7 })).toBeDefined()
  })
})

describe("native compaction in the runtime", () => {
  let tmp: string
  let reg: SessionsRegistry
  let bus: SessionEventBus
  let got: SessionContextCompactedEvent[]

  const makeRegistry = (extra?: Parameters<typeof createSessionsRegistry>[0]) => {
    bus = createSessionEventBus()
    got = captureCompactions(bus)
    reg = createSessionsRegistry({
      persist: false,
      transcriptDir: tmp,
      contextRescueSettleMs: 100,
      sessionEvents: bus,
      ...extra,
    })
  }

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "native-compaction-"))
  })
  afterEach(async () => {
    vi.useRealTimers()
    reg.shutdown()
    await reg.settlePendingWrites()
    rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  })

  const spawn = (h: AgentSessionLike, partial?: Partial<ResolvedContextContinuityPolicy>) =>
    reg.spawnAgent({
      workspaceSlug: "default",
      cwd: tmp,
      agentSession: h,
      adapterSlug: "fake",
      label: "native",
      ...(partial ? { contextContinuity: { ...CONTEXT_CONTINUITY_DEFAULTS, ...partial } } : {}),
    }).id

  const outputOf = (id: string): string[] => {
    const lines: string[] = []
    reg.attach(id, line => lines.push(line))?.()
    return lines
  }
  const detectedLines = (id: string) => outputOf(id).filter(l => l.includes("native compaction detected"))

  describe("D2: a native drop", () => {
    it("emits exactly one event with the right fields, and a transcript line", async () => {
      makeRegistry()
      const h = harness({ turns: [[150_000, 30_000], [30_000, 40_000, 50_000]], size: 200_000 })
      const id = spawn(h)
      const before = { ...reg.get(id)! } as SessionDescriptor
      await reg.sendPrompt(id, "work")
      expect(got).toHaveLength(1)
      const ev = got[0]!
      expect(ev).toMatchObject({
        type: EVENT,
        sessionId: id,
        usedBefore: 150_000,
        usedAfter: 30_000,
        contextSize: 200_000,
        guarded: false,
        label: "native",
      })
      expect(ev.occurrenceId).toBe(`compact:${ev.ts}`)
      expect(Number.isNaN(Date.parse(ev.ts))).toBe(false)
      expect(detectedLines(id)).toEqual([
        "[context] native compaction detected: 150000 -> 30000 tokens (checkpoint: none)",
      ])
      // Nothing new on the descriptor: only the usual `contextUsed` moved.
      const after = reg.get(id)!
      expect(after.contextUsed).toBe(30_000)
      expect(Object.keys(after).filter(k => /compact|native/i.test(k) && !(k in before))).toEqual([])

      // A second turn that stays low compares against the new sample.
      await reg.sendPrompt(id, "more")
      expect(got).toHaveLength(1)
      expect(detectedLines(id)).toHaveLength(1)
    })
  })

  describe("D3: drops that are not a native compaction", () => {
    it("the daemon's own auto-compaction (the /compact turn)", async () => {
      makeRegistry()
      const h = harness({ turns: [[200_000]], size: 1_000_000, advertiseCommand: true })
      const id = spawn(h, { mode: "auto", autoCompactAtTokens: 150_000 })
      await reg.sendPrompt(id, "work")
      await vi.waitFor(() => expect(outputOf(id).join("\n")).toMatch(/nothing in progress: no resume prompt/), { timeout: 5_000 })
      expect(h.prompts.some(p => p.startsWith("/compact"))).toBe(true)
      expect(reg.get(id)?.contextUsed).toBe(1_000)
      expect(got).toEqual([])
      expect(detectedLines(id)).toEqual([])
    })

    it("an operator /compact prompt", async () => {
      makeRegistry()
      const h = harness({ turns: [[150_000]], size: 200_000, compactFrames: [5_000] })
      const id = spawn(h)
      await reg.sendPrompt(id, "work")
      await reg.sendPrompt(id, "/compact")
      expect(reg.get(id)?.contextUsed).toBe(5_000)
      expect(got).toEqual([])
      expect(detectedLines(id)).toEqual([])
    })

    it("the floor rescue, including a frame that lands after its /compact turn", async () => {
      makeRegistry({ contextRescueSettleMs: 3_000 })
      // No advertised /compact: the absolute auto-compact stays out, the floor acts.
      const h = harness({ turns: [[185_000]], size: 200_000, compactFrames: [] })
      const id = spawn(h)
      await reg.sendPrompt(id, "work")
      await vi.waitFor(() => expect(h.prompts.some(p => p.startsWith("/compact"))).toBe(true), { timeout: 5_000 })
      await vi.waitFor(() => expect(reg.get(id)?.busy).toBe(false), { timeout: 5_000 })
      // The harness reports the compacted window only after the turn ended.
      h.emitOutOfTurn({ kind: "usage_update", size: 200_000, used: 20_000 })
      await vi.waitFor(() => expect(outputOf(id).join("\n")).toMatch(/compacted/), { timeout: 5_000 })
      await vi.waitFor(() => expect(reg.get(id)?.contextUsed).toBe(20_000), { timeout: 5_000 })
      expect(got).toEqual([])
      expect(detectedLines(id)).toEqual([])
    })

    it("the first frame of a session", async () => {
      makeRegistry()
      const h = harness({ turns: [[30_000]], size: 200_000 })
      const id = spawn(h)
      reg.get(id)!.contextUsed = 150_000
      await reg.sendPrompt(id, "work")
      expect(reg.get(id)?.contextUsed).toBe(30_000)
      expect(got).toEqual([])
    })

    it("a frame past the window (contextUsedInconsistent) is not a sample", async () => {
      makeRegistry()
      // 150k accepted, then a cumulative-looking 900k past the 200k window,
      // then 120k: a drop from 900k would be detected, from 150k it is not.
      const h = harness({ turns: [[150_000, 900_000, 120_000]], size: 200_000 })
      const id = spawn(h)
      await reg.sendPrompt(id, "work")
      expect(reg.get(id)?.contextUsed).toBe(120_000)
      expect(got).toEqual([])
    })

    it("the first frame after a resume, against a high persisted contextUsed", async () => {
      const persistPath = join(tmp, "sessions.json")
      const id = "sess_native_resume"
      mkdirSync(tmp, { recursive: true })
      writeFileSync(
        persistPath,
        JSON.stringify({
          savedAt: "2026-10-28T00:00:00Z",
          sessions: [
            {
              id,
              kind: "agent-cli",
              workspaceSlug: "default",
              command: "fake (agent)",
              pid: null,
              status: "running",
              startedAt: "2026-10-28T00:00:00Z",
              busy: false,
              adapterSlug: "fake",
              adapterSessionId: "conv-native",
              cwd: tmp,
              contextSize: 200_000,
              contextUsed: 150_000,
            },
          ],
        }),
      )
      const h = harness({ turns: [[30_000]], size: 200_000 })
      makeRegistry({ persist: undefined, persistPath, resumeAgent: vi.fn(async () => h) })
      expect(reg.get(id)?.contextUsed).toBe(150_000)
      await reg.sendPrompt(id, "continue")
      expect(h.prompts).toHaveLength(1)
      expect(reg.get(id)?.contextUsed).toBe(30_000)
      expect(got).toEqual([])
    })
  })

  describe("D4: the guard window", () => {
    it("a checkpoint 30 s before the drop: guarded", async () => {
      vi.useFakeTimers({ toFake: ["Date"] })
      const t0 = new Date("2026-10-28T10:00:00.000Z").getTime()
      vi.setSystemTime(t0)
      makeRegistry()
      const h = harness({ turns: [[150_000], [30_000]], size: 200_000 })
      const id = spawn(h)
      await reg.sendPrompt(id, "work")
      reg.noteCheckpointWritten(id)
      vi.setSystemTime(t0 + 30_000)
      await reg.sendPrompt(id, "more")
      expect(got).toHaveLength(1)
      expect(got[0]!.guarded).toBe(true)
      expect(detectedLines(id)).toEqual([
        "[context] native compaction detected: 150000 -> 30000 tokens (checkpoint: written 30s earlier)",
      ])
    })

    it("a checkpoint 5 minutes before the drop: not guarded", async () => {
      vi.useFakeTimers({ toFake: ["Date"] })
      const t0 = new Date("2026-10-28T10:00:00.000Z").getTime()
      vi.setSystemTime(t0)
      makeRegistry()
      const h = harness({ turns: [[150_000], [30_000]], size: 200_000 })
      const id = spawn(h)
      await reg.sendPrompt(id, "work")
      reg.noteCheckpointWritten(id)
      vi.setSystemTime(t0 + 5 * 60_000)
      await reg.sendPrompt(id, "more")
      expect(got).toHaveLength(1)
      expect(got[0]!.guarded).toBe(false)
      expect(detectedLines(id)).toEqual([
        "[context] native compaction detected: 150000 -> 30000 tokens (checkpoint: none)",
      ])
    })

    const afterDaemonCompact = async (laterMs: number): Promise<SessionContextCompactedEvent[]> => {
      vi.useFakeTimers({ toFake: ["Date"] })
      const t0 = new Date("2026-10-28T10:00:00.000Z").getTime()
      vi.setSystemTime(t0)
      makeRegistry()
      const h = harness({ turns: [[200_000], [100_000], [20_000]], size: 1_000_000, advertiseCommand: true })
      const id = spawn(h, { mode: "auto", autoCompactAtTokens: 150_000 })
      await reg.sendPrompt(id, "work")
      await vi.waitFor(() => expect(outputOf(id).join("\n")).toMatch(/nothing in progress: no resume prompt/), { timeout: 5_000 })
      await vi.waitFor(() => expect(reg.get(id)?.busy).toBe(false), { timeout: 5_000 })
      await sleep(50)
      await reg.sendPrompt(id, "grow")
      expect(got).toEqual([])
      vi.setSystemTime(t0 + laterMs)
      await reg.sendPrompt(id, "drop")
      return got
    }

    it("the checkpoint of a daemon /compact earlier in the session counts inside the window", async () => {
      const events = await afterDaemonCompact(30_000)
      expect(events).toHaveLength(1)
      expect(events[0]).toMatchObject({ usedBefore: 100_000, usedAfter: 20_000, guarded: true })
    })

    it("and not outside it", async () => {
      const events = await afterDaemonCompact(5 * 60_000)
      expect(events).toHaveLength(1)
      expect(events[0]).toMatchObject({ usedBefore: 100_000, usedAfter: 20_000, guarded: false })
    })
  })
})

describe("D5: the checkpoint routes note the checkpoint", () => {
  let tmp: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "native-compaction-routes-"))
    setDefaultSessionsBaseDir(tmp)
  })
  afterEach(() => {
    setDefaultSessionsBaseDir(undefined)
    rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
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

  it("POST /sessions/:id/checkpoint: a following native drop is guarded", async () => {
    const bus = createSessionEventBus()
    const got = captureCompactions(bus)
    const registry = createSessionsRegistry({ persist: false, transcriptDir: tmp, sessionEvents: bus })
    const resolveAgentAdapter: AgentAdapterResolver = async () => ({
      startSession: async () => harness({ turns: [[150_000], [30_000]], size: 200_000 }),
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
    try {
      const base = `http://127.0.0.1:${port}`
      const post = (path: string, body?: unknown) =>
        fetch(`${base}${path}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body ?? {}),
        })
      const src = await post("/sessions/agent", { adapter: "claude-code", cwd: tmp })
      expect(src.status).toBe(201)
      const { id } = (await src.json()) as SessionDescriptor
      await registry.sendPrompt(id, "work")
      expect((await post(`/sessions/${id}/checkpoint`)).status).toBe(200)
      await registry.sendPrompt(id, "more")
      expect(got).toHaveLength(1)
      expect(got[0]!.guarded).toBe(true)
    } finally {
      await http.stop()
      registry.shutdown()
    }
  })

  it("session_checkpoint: a following native drop is guarded", async () => {
    const bus = createSessionEventBus()
    const got = captureCompactions(bus)
    const reg = createSessionsRegistry({ persist: false, transcriptDir: tmp, sessionEvents: bus })
    const server = new McpServer({ name: "t", version: "0" })
    registerSessionTools(server, { registry: reg, workspace: tmp })
    const [c, s] = InMemoryTransport.createLinkedPair()
    await server.connect(s)
    const client = new Client({ name: "t-client", version: "0" })
    await client.connect(c)
    try {
      const id = reg.spawnAgent({
        workspaceSlug: "default",
        cwd: tmp,
        agentSession: harness({ turns: [[150_000], [30_000]], size: 200_000 }),
        adapterSlug: "fake",
      }).id
      await reg.sendPrompt(id, "work")
      const result = await client.callTool({ name: "session_checkpoint", arguments: { sessionId: id, askSource: false } })
      expect((result as { isError?: boolean }).isError).toBeFalsy()
      await reg.sendPrompt(id, "more")
      expect(got).toHaveLength(1)
      expect(got[0]!.guarded).toBe(true)
    } finally {
      await client.close()
      reg.shutdown()
      await reg.settlePendingWrites()
    }
  })
})

describe("D6: registration", () => {
  it("lists agentproto:context-compacted as a nonportable agentproto host event", () => {
    const reg = HOST_EVENT_REGISTRATIONS.find(entry => entry.event === EVENT)
    expect(reg).toMatchObject({ event: EVENT, host: "agentproto", portability: "nonportable" })
    expect(Object.isFrozen(reg)).toBe(true)
  })

  it("a routine on agentproto:context-compacted parses", () => {
    const binding = resolveRoutineEventBinding({
      schema: "routine/v1",
      id: "on-native-compaction",
      description: "test",
      version: "1.0.0",
      schedule: { kind: "event", on: EVENT },
      target: { tool: "worktree_gc", inputs: {} },
      enabled: true,
      fires_events: [],
      tags: [],
    } as unknown as RoutineFrontmatter)
    expect(binding?.event.event).toBe(EVENT)
  })
})
