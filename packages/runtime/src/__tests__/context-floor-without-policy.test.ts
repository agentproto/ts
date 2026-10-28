/**
 * The context hard-stop floor is the safety core of the context design: a
 * session must never be left stuck at the edge of its window. It holds for
 * a session spawned with no `contextContinuity` policy too (a direct
 * registry spawn, a sandbox spawn, a daemon with no default policy), at
 * admission and at the turn boundary, and the checkpoint routes work for
 * such a session. The percent ladder below the floor stays off without a
 * policy.
 *
 * Also: once an auto-compaction releases the context lock, the session is
 * evaluated once more, so a compaction that did not free enough is acted on
 * right away instead of at the next prompt.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createServer } from "node:http"
import { AddressInfo } from "node:net"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createMcpServer } from "@agentproto/mcp-server"

import {
  CONTEXT_CONTINUITY_DEFAULTS,
  type ResolvedContextContinuityPolicy,
} from "../context-continuity.js"
import type { ConversationStore } from "../conversations.js"
import { createRuntimeEvents } from "../events.js"
import type { HeartbeatRunner } from "../heartbeat.js"
import { startHttpServer, type AgentAdapterResolver } from "../http-server.js"
import {
  createSessionsRegistry,
  type AgentSessionLike,
  type AgentStreamEvent,
  type SessionsRegistry,
} from "../sessions.js"
import { sessionTranscriptDir, setDefaultSessionsBaseDir } from "../transcript-writer.js"

interface Harness extends AgentSessionLike {
  prompts: string[]
}

interface HarnessOpts {
  /** `used` reported by every usage frame of a turn, in order. */
  frames: number[]
  size: number
  usedAfterCompact?: number
}

/** Real adapters advertise compaction as a slash command (available-commands), never as a session mode. */
function harness(o: HarnessOpts): Harness {
  let frames = o.frames
  let advertised = false
  const h: Harness = {
    sessionId: "acp-floor",
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
      if (text.startsWith("/compact") || text.startsWith("/compress")) {
        frames = [o.usedAfterCompact ?? 10]
      }
      yield { kind: "text-delta", text: "ok" }
      for (const used of frames) yield { kind: "usage_update", size: o.size, used }
      yield { kind: "turn-end" }
    },
    async cancel() {},
    async close() {},
  }
  return h
}

const isCompact = (p: string): boolean => p.startsWith("/compact")
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

function freshAdapter(fresh: Harness[]): AgentAdapterResolver {
  return async () => ({
    startSession: async () => {
      const f = harness({ frames: [1_000], size: 200_000 })
      fresh.push(f)
      return f
    },
    commandPreview: "fake",
  })
}

describe("the context floor holds without a policy", () => {
  let tmp: string
  let reg: SessionsRegistry

  const makeRegistry = (extra?: Parameters<typeof createSessionsRegistry>[0]) => {
    reg = createSessionsRegistry({ persist: false, transcriptDir: tmp, contextRescueSettleMs: 100, ...extra })
  }

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "ctx-floor-"))
  })
  afterEach(async () => {
    reg.shutdown()
    await reg.settlePendingWrites()
    rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  })

  /** No `contextContinuity` unless one is given: `reg.spawnAgent` stores what it gets. */
  const spawn = (h: AgentSessionLike, partial?: Partial<ResolvedContextContinuityPolicy>) =>
    reg.spawnAgent({
      workspaceSlug: "default",
      cwd: tmp,
      agentSession: h,
      adapterSlug: "fake",
      ...(partial ? { contextContinuity: { ...CONTEXT_CONTINUITY_DEFAULTS, ...partial } } : {}),
    }).id

  const outputOf = (id: string): string[] => {
    const lines: string[] = []
    reg.attach(id, line => lines.push(line))?.()
    return lines
  }

  it("F1: admission refuses a prompt into a full window and starts the rescue", async () => {
    makeRegistry()
    const h = harness({ frames: [50], size: 100, usedAfterCompact: 10 })
    const id = spawn(h)
    await reg.sendPrompt(id, "work")
    expect(reg.get(id)?.contextContinuity).toBeUndefined()
    // The window filled up without a turn boundary seeing it (a usage reading
    // restored from disk, a frame after the turn ended): only admission can act.
    reg.get(id)!.contextUsed = 95
    await expect(reg.sendPrompt(id, "more")).rejects.toThrow(/context at 95%/)
    expect(h.prompts).not.toContain("more")
    await vi.waitFor(() => expect(h.prompts.some(isCompact)).toBe(true), { timeout: 4_000 })
    await vi.waitFor(
      () => expect(outputOf(id).join("\n")).toMatch(/auto-compacted at the hard-stop floor/),
      { timeout: 4_000 },
    )
    expect(reg.get(id)?.status).toBe("running")
    await reg.sendPrompt(id, "still there?")
    expect(h.prompts.at(-1)).toBe("still there?")
  })

  it("F2: the turn boundary starts the rescue on its own, with no second prompt", async () => {
    makeRegistry()
    const h = harness({ frames: [95], size: 100, usedAfterCompact: 10 })
    const id = spawn(h)
    await reg.sendPrompt(id, "work")
    await vi.waitFor(() => expect(h.prompts.some(isCompact)).toBe(true), { timeout: 4_000 })
    await vi.waitFor(
      () => expect(outputOf(id).join("\n")).toMatch(/auto-compacted at the hard-stop floor/),
      { timeout: 4_000 },
    )
    expect(reg.get(id)?.status).toBe("running")
    expect(reg.get(id)?.contextContinuityHardStopped).toBeFalsy()
  })

  it("F2b: a compaction that does not help and no adapter resolver ends in a hard stop", async () => {
    makeRegistry()
    const h = harness({ frames: [95], size: 100, usedAfterCompact: 95 })
    const id = spawn(h)
    await reg.sendPrompt(id, "work")
    await vi.waitFor(() => expect(reg.get(id)?.status).toBe("killed"), { timeout: 4_000 })
    expect(reg.get(id)?.endedReason).toBe("context-hard-stop")
    expect(h.prompts.filter(isCompact)).toHaveLength(1)
  })

  it("F2c: a compaction that does not help continues fresh when an adapter resolver is wired", async () => {
    const fresh: Harness[] = []
    makeRegistry({ resolveAgentAdapter: freshAdapter(fresh) })
    const h = harness({ frames: [95], size: 100, usedAfterCompact: 95 })
    const id = spawn(h)
    await reg.sendPrompt(id, "work")
    await vi.waitFor(
      () => expect(outputOf(id).join("\n")).toMatch(/the session was continued fresh/),
      { timeout: 4_000 },
    )
    expect(fresh).toHaveLength(1)
    expect(reg.get(id)?.endedReason).not.toBe("context-hard-stop")
  })

  describe("F3: below the floor nothing changes without a policy", () => {
    for (const used of [70, 80]) {
      it(`at ${used}%: no compaction, no question, no continue-fresh`, async () => {
        const fresh: Harness[] = []
        makeRegistry({ resolveAgentAdapter: freshAdapter(fresh) })
        const h = harness({ frames: [used], size: 100 })
        const id = spawn(h)
        await reg.sendPrompt(id, "work")
        await sleep(300)
        expect(h.prompts).toEqual(["work"])
        expect(fresh).toHaveLength(0)
        const desc = reg.get(id)!
        expect(desc.awaitingInput ?? false).toBe(false)
        expect(desc.status).toBe("running")
        await reg.sendPrompt(id, "more")
        expect(h.prompts.at(-1)).toBe("more")
      })
    }

    it("an inconsistent usage reading does not rescue", async () => {
      makeRegistry()
      // 95 is recorded, then a frame past the window marks the reading unreliable.
      const h = harness({ frames: [95, 500], size: 100 })
      const id = spawn(h)
      await reg.sendPrompt(id, "work")
      await sleep(300)
      expect(reg.get(id)?.contextUsed).toBe(95)
      expect(h.prompts).toEqual(["work"])
      expect(reg.get(id)?.status).toBe("running")
      await reg.sendPrompt(id, "more")
      expect(h.prompts.at(-1)).toBe("more")
    })
  })

  describe("re-evaluation after an auto-compaction", () => {
    it("continues fresh right after a compaction that left the session above continueFreshAtPct", async () => {
      const fresh: Harness[] = []
      makeRegistry({ resolveAgentAdapter: freshAdapter(fresh) })
      // 60% (warn band) but above the token threshold: auto-compact fires,
      // and the compaction lands the session at 80%.
      const h = harness({ frames: [120_000], size: 200_000, usedAfterCompact: 160_000 })
      const id = spawn(h, { mode: "auto", continueFreshAtPct: 75, autoCompactAtTokens: 100_000 })
      await reg.sendPrompt(id, "work")
      await vi.waitFor(() => expect(reg.get(id)?.status).toBe("killed"), { timeout: 4_000 })
      await sleep(300)
      expect(outputOf(id).join("\n")).toMatch(/continued fresh to /)
      expect(fresh).toHaveLength(1)
      // Exactly one compaction: the re-evaluation does not re-trigger auto-compact.
      expect(h.prompts.filter(isCompact)).toHaveLength(1)
      expect(h.prompts).toHaveLength(2)
    })

    it("does not loop when the compaction is refused", async () => {
      makeRegistry()
      const h = harness({ frames: [120_000], size: 200_000, usedAfterCompact: 160_000 })
      const id = spawn(h, { mode: "auto", autoCompactAtTokens: 100_000 })
      // A regular file where the checkpoint directory must go: the gate refuses the compaction.
      mkdirSync(sessionTranscriptDir(id, tmp), { recursive: true })
      writeFileSync(join(sessionTranscriptDir(id, tmp), "checkpoints"), "not a directory")
      await reg.sendPrompt(id, "work")
      await vi.waitFor(
        () => expect(outputOf(id).join("\n")).toMatch(/\[auto-compact\] failed: .*compaction refused/),
        { timeout: 3_000 },
      )
      await sleep(500)
      const failures = outputOf(id).filter(l => /\[auto-compact\] failed/.test(l))
      expect(failures).toHaveLength(1)
      expect(h.prompts).toEqual(["work"])
    })
  })
})

describe("checkpoint routes without a policy", () => {
  let tmp: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "ctx-floor-http-"))
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

  async function boot() {
    const registry = createSessionsRegistry({ persist: false, transcriptDir: tmp })
    const port = await freePort()
    const http = await startHttpServer({
      port,
      auth: { mode: "none" },
      mcpServerFactory: async () => (await createMcpServer({ specs: [], name: "t", version: "0" })).server,
      conversations,
      events: createRuntimeEvents(),
      heartbeat,
      sessions: registry,
      meta: { workspace: process.cwd(), registered: [] },
    })
    const id = registry.spawnAgent({
      workspaceSlug: "default",
      cwd: tmp,
      agentSession: harness({ frames: [50], size: 100 }),
      adapterSlug: "fake",
    }).id
    const post = (path: string, body?: unknown) =>
      fetch(`http://127.0.0.1:${port}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body ?? {}),
      })
    return {
      registry,
      id,
      post,
      stop: async () => {
        await http.stop()
        registry.shutdown()
      },
    }
  }

  it("F4: POST /sessions/:id/checkpoint answers 200 with a checkpointId", async () => {
    const h = await boot()
    try {
      expect(h.registry.get(h.id)?.contextContinuity).toBeUndefined()
      const res = await h.post(`/sessions/${h.id}/checkpoint`)
      const body = (await res.json()) as { checkpointId?: string; path?: string; error?: string }
      expect(body.error).toBeUndefined()
      expect(res.status).toBe(200)
      expect(body.checkpointId).toMatch(/^ckpt_/)
      expect(existsSync(body.path!)).toBe(true)
    } finally {
      await h.stop()
    }
  })

  it("F4b: POST /sessions/:id/handoff with dryRun answers 200", async () => {
    const h = await boot()
    try {
      const res = await h.post(`/sessions/${h.id}/handoff`, { to: "codex", dryRun: true })
      const body = (await res.json()) as { dryRun?: boolean; prompt?: string; error?: string }
      expect(body.error).toBeUndefined()
      expect(res.status).toBe(200)
      expect(body.dryRun).toBe(true)
      expect(typeof body.prompt).toBe("string")
    } finally {
      await h.stop()
    }
  })
})
