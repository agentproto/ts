/**
 * One owner for runtime-initiated context compaction:
 *  - the percent-band compaction (`compactAtPct`) is not performed, the
 *    absolute auto-compact controller owns compaction;
 *  - an auto-compaction writes ONE checkpoint, and its goal still reaches
 *    the resume prompt;
 *  - auto-compact holds `contextRescue` for its whole run, so a prompt that
 *    arrives meanwhile waits instead of breaking the compaction;
 *  - continue-fresh at the turn boundary holds the same lock, so the two
 *    owners never act on one session in the same turn boundary.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  CONTEXT_CONTINUITY_DEFAULTS,
  type ResolvedContextContinuityPolicy,
} from "../context-continuity.js"
import type { AgentAdapterResolver } from "../http-server.js"
import type { SessionObserver } from "../session-observer.js"
import {
  createSessionsRegistry,
  type AgentSessionLike,
  type AgentStreamEvent,
  type SessionsRegistry,
} from "../sessions.js"
import { sessionTranscriptDir } from "../transcript-writer.js"

interface Harness extends AgentSessionLike {
  prompts: string[]
  modeSwitches: string[]
}

interface HarnessOpts {
  used: number
  size: number
  usedAfterCompact?: number
  /** Advertise `/compact` as a slash command, the way real adapters do. */
  advertiseCommand?: boolean
  availableModes?: Array<{ id: string; name: string }>
  turnEndReason?: string
  /** Called with each prompt as it reaches the harness. */
  onPrompt?: (text: string) => void
}

function harness(o: HarnessOpts): Harness {
  let current = o.used
  let advertised = !(o.advertiseCommand ?? true)
  const h: Harness = {
    sessionId: "acp-owner",
    prompts: [],
    modeSwitches: [],
    availableModes: o.availableModes ?? [],
    async *send(message): AsyncIterable<AgentStreamEvent> {
      const text = (Array.isArray(message) ? message : [message])
        .map(b => (typeof b === "string" ? b : ((b as { text?: string } | undefined)?.text ?? "")))
        .join("")
      h.prompts.push(text)
      o.onPrompt?.(text)
      if (!advertised) {
        advertised = true
        yield { kind: "available-commands", commands: [{ name: "compact", description: "Compact the conversation" }] }
      }
      if (text.startsWith("/compact") || text.startsWith("/compress")) {
        current = o.usedAfterCompact ?? 1_000
      }
      yield { kind: "text-delta", text: "ok" }
      yield { kind: "usage_update", size: o.size, used: current }
      yield o.turnEndReason ? { kind: "turn-end", reason: o.turnEndReason } : { kind: "turn-end" }
    },
    async cancel() {},
    async close() {},
    async setSessionMode(modeId: string) {
      h.modeSwitches.push(modeId)
      return { applied: true, modeId }
    },
  }
  return h
}

const isCompact = (p: string): boolean => p.startsWith("/compact")
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

/** An extra session observer whose `drain` can be held once armed: every
 *  checkpoint drains the transcript first, so holding it holds the
 *  checkpoint. Recording a prompt drains too, hence the arming. */
function holdableObserver() {
  let armed = false
  let release!: () => void
  const gate = new Promise<void>(r => (release = r))
  let entered!: () => void
  const drainEntered = new Promise<void>(r => (entered = r))
  const observer: SessionObserver = {
    recordPrompt() {},
    recordEvent() {},
    recordUsageSnapshot() {},
    async drain() {
      if (!armed) return
      entered()
      await gate
    },
    async close() {},
    async closeAll() {},
  }
  return { observer, drainEntered, release, arm: () => {
      armed = true
    } }
}

describe("context compaction has one owner", () => {
  let tmp: string
  let reg: SessionsRegistry

  const makeRegistry = (extra?: Parameters<typeof createSessionsRegistry>[0]) => {
    reg = createSessionsRegistry({ persist: false, transcriptDir: tmp, contextRescueSettleMs: 100, ...extra })
  }

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "ctx-owner-"))
  })
  afterEach(async () => {
    reg.shutdown()
    await reg.settlePendingWrites()
    rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  })

  // A terminal row's output rings are dropped at exit, so capture the live
  // stream from spawn instead of reading the (now-empty) replay buffer later.
  const outputs = new Map<string, string[]>()
  const spawn = (
    h: AgentSessionLike,
    partial: Partial<ResolvedContextContinuityPolicy>,
    extra?: { trace?: boolean; adapterSlug?: string; title?: string },
  ) => {
    const desc = reg.spawnAgent({
      workspaceSlug: "default",
      cwd: tmp,
      agentSession: h,
      adapterSlug: extra?.adapterSlug ?? "fake",
      contextContinuity: { ...CONTEXT_CONTINUITY_DEFAULTS, ...partial },
      ...(extra?.trace ? { trace: true } : {}),
      ...(extra?.title ? { title: extra.title } : {}),
    })
    const lines: string[] = []
    outputs.set(desc.id, lines)
    reg.attach(desc.id, line => lines.push(line))
    return desc.id
  }

  const outputOf = (id: string): string[] => outputs.get(id) ?? []

  describe("S1: the percent-band compaction is not performed", () => {
    it("never switches a harness with a compact mode into it between compactAtPct and continueFreshAtPct", async () => {
      makeRegistry()
      const h = harness({ used: 70, size: 100, advertiseCommand: false, availableModes: [{ id: "compact", name: "Compact" }] })
      const id = spawn(h, { mode: "auto", autoCompactAtTokens: 0 })
      await reg.sendPrompt(id, "work")
      await sleep(300)
      expect(h.modeSwitches).not.toContain("compact")
      expect(outputOf(id).join("\n")).not.toMatch(/compact requested from harness/)
      expect(reg.get(id)?.status).toBe("running")
    })

    it("does not complain about missing compact support either", async () => {
      makeRegistry()
      const h = harness({ used: 70, size: 100, advertiseCommand: false })
      const id = spawn(h, { mode: "auto", autoCompactAtTokens: 0 })
      await reg.sendPrompt(id, "work")
      await sleep(300)
      expect(outputOf(id).join("\n")).not.toMatch(/does not advertise compact support/)
    })
  })

  describe("S2/S3: one checkpoint per auto-compaction", () => {
    it("S2: writes exactly one checkpoint for the compaction", async () => {
      makeRegistry()
      const h = harness({ used: 200_000, size: 1_000_000 })
      const id = spawn(h, { mode: "auto", autoCompactAtTokens: 150_000 })
      await reg.sendPrompt(id, "work")
      await vi.waitFor(() => expect(h.prompts.filter(isCompact)).toHaveLength(1), { timeout: 5_000 })
      await vi.waitFor(() => expect(outputOf(id).join("\n")).toMatch(/nothing in progress: no resume prompt/), { timeout: 5_000 })
      const written = outputOf(id).filter(l => /checkpoint \S+ written to .* before /.test(l))
      expect(written).toHaveLength(1)
    })

    it("S3: the resume prompt still carries the goal from that checkpoint", async () => {
      makeRegistry()
      const h = harness({ used: 200_000, size: 1_000_000, turnEndReason: "error" })
      // A title of its own: the first prompt would otherwise become the
      // title, and a goal equal to the title is not repeated as a mission.
      const id = spawn(h, { mode: "auto", autoCompactAtTokens: 150_000 }, { title: "storage worker" })
      await reg.sendPrompt(id, "Ship the storage migration to Postgres")
      await vi.waitFor(() => expect(h.prompts.some(p => p.startsWith("[auto-compact]"))).toBe(true), { timeout: 5_000 })
      const resume = h.prompts.find(p => p.startsWith("[auto-compact]"))!
      expect(resume).toContain("Mission: Ship the storage migration to Postgres")
    })
  })

  describe("S2b: a compaction whose checkpoint cannot be written", () => {
    it("is refused: the failure is surfaced, no /compact reaches the harness, no resume prompt", async () => {
      makeRegistry()
      const h = harness({ used: 200_000, size: 1_000_000, turnEndReason: "error" })
      const id = spawn(h, { mode: "auto", autoCompactAtTokens: 150_000 }, { title: "storage worker" })
      // A regular file where the checkpoint directory must go.
      mkdirSync(sessionTranscriptDir(id, tmp), { recursive: true })
      writeFileSync(join(sessionTranscriptDir(id, tmp), "checkpoints"), "not a directory")
      await reg.sendPrompt(id, "Ship the storage migration to Postgres")
      await vi.waitFor(
        () => expect(outputOf(id).join("\n")).toMatch(/\[auto-compact\] failed: .*compaction refused/),
        { timeout: 3_000 },
      )
      await sleep(200)
      expect(h.prompts).toEqual(["Ship the storage migration to Postgres"])
      expect(reg.get(id)?.status).toBe("running")
    })
  })

  describe("S4: a prompt arriving during the auto-compaction waits for it", () => {
    it("holds direct and queued prompts until the compaction turn has ended", async () => {
      const hold = holdableObserver()
      makeRegistry({ langfuseTracer: hold.observer })
      // Armed inside the first turn, after its prompt was recorded: the next
      // drain is the auto-compaction's checkpoint.
      const h = harness({ used: 200_000, size: 1_000_000, onPrompt: t => t === "work" && hold.arm() })
      const id = spawn(h, { mode: "auto", autoCompactAtTokens: 150_000 }, { trace: true })
      try {
        await reg.sendPrompt(id, "work")
        // The auto-compaction is now writing its checkpoint, and holds there.
        await hold.drainEntered
        let direct: unknown
        try {
          await reg.sendPrompt(id, "direct while compacting")
          direct = "delivered"
        } catch (err) {
          direct = err
        }
        expect(direct).toBeInstanceOf(Error)
        expect((direct as Error).message).toMatch(/retry shortly/)
        const queued = await reg.enqueuePrompt(id, "queued while compacting", { queue: true })
        expect(queued.queued).toBe(true)
        expect(h.prompts).toEqual(["work"])
      } finally {
        hold.release()
      }
      // The queued prompt also carries the auto-compact transcript note.
      const isQueued = (p: string) => p.endsWith("queued while compacting")
      await vi.waitFor(() => expect(h.prompts.some(isQueued)).toBe(true), { timeout: 3_000 })
      expect(h.prompts).toHaveLength(3)
      expect(h.prompts[0]).toBe("work")
      expect(isCompact(h.prompts[1]!)).toBe(true)
      expect(isQueued(h.prompts[2]!)).toBe(true)
      expect(outputOf(id).join("\n")).not.toMatch(/\[auto-compact\] failed/)
    })
  })

  describe("S5: continue-fresh and auto-compact at the same turn boundary", () => {
    it("lets only continue-fresh act: no /compact reaches the old session", async () => {
      const fresh: Harness[] = []
      const resolveAgentAdapter: AgentAdapterResolver = async () => ({
        startSession: async () => {
          const f = harness({ used: 1_000, size: 200_000 })
          fresh.push(f)
          return f
        },
        commandPreview: "fake",
      })
      makeRegistry({ resolveAgentAdapter })
      const h = harness({ used: 150_000, size: 200_000 })
      const id = spawn(h, { mode: "auto" })
      await reg.sendPrompt(id, "work")
      await vi.waitFor(() => expect(reg.get(id)?.status).toBe("killed"), { timeout: 5_000 })
      await sleep(300)
      expect(h.prompts).toEqual(["work"])
      expect(fresh).toHaveLength(1)
      expect(outputOf(id).join("\n")).toMatch(/continued fresh to /)
    })
  })
})
