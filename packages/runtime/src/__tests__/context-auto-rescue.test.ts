/**
 * The context floor is a trigger, not a wall: at `hardStopAtPct` the runtime
 * compacts the session by itself (checkpoint first), holds prompts while it
 * does, and only stops — loudly, with an event — when it cannot recover.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createSessionsRegistry, type AgentSessionLike, type AgentStreamEvent, type SessionsRegistry } from "../sessions.js"
import { createSessionEventBus, type SessionContextRescueEvent } from "../session-event-bus.js"
import { CONTEXT_CONTINUITY_DEFAULTS } from "../context-continuity.js"

interface Gated extends AgentSessionLike {
  prompts: string[]
  releaseCompact: () => void
}

/** Reports `used` after ordinary turns; `/compact` waits on a gate, then drops to `usedAfterCompact`. */
function gatedHarness(used: number, usedAfterCompact: number, gateCompact: boolean): Gated {
  let current = used
  let release!: () => void
  const gate = new Promise<void>(r => (release = r))
  const h: Gated = {
    sessionId: "acp-gated",
    prompts: [],
    releaseCompact: () => release(),
    async *send(message): AsyncIterable<AgentStreamEvent> {
      const text = (Array.isArray(message) ? message : [message])
        .map(b => (typeof b === "string" ? b : ((b as { text?: string } | undefined)?.text ?? "")))
        .join("")
      h.prompts.push(text)
      if (text.startsWith("/compact")) {
        if (gateCompact) await gate
        current = usedAfterCompact
        yield { kind: "usage_update", size: 100, used: current }
      } else {
        yield { kind: "text-delta", text: "ok" }
        yield { kind: "usage_update", size: 100, used: current }
      }
      yield { kind: "turn-end" }
    },
    async cancel() {},
    async close() {},
  }
  return h
}

describe("automatic context rescue at the floor", () => {
  let tmp: string
  let reg: SessionsRegistry
  let events: SessionContextRescueEvent[]

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "ctx-rescue-"))
    const bus = createSessionEventBus()
    events = []
    bus.on("session:context-rescue", ev => events.push(ev))
    reg = createSessionsRegistry({
      persist: false,
      transcriptDir: tmp,
      sessionEvents: bus,
      contextRescueSettleMs: 100,
    })
  })
  afterEach(() => {
    reg.shutdown()
    rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  })

  const spawn = (h: AgentSessionLike) =>
    reg.spawnAgent({
      workspaceSlug: "default",
      cwd: tmp,
      agentSession: h,
      adapterSlug: "fake",
      contextContinuity: { ...CONTEXT_CONTINUITY_DEFAULTS, label: "t", mode: "manual" },
    }).id

  it("announces a successful compaction and leaves the session running", async () => {
    const id = spawn(gatedHarness(95, 10, false))
    await reg.sendPrompt(id, "hello")
    await vi.waitFor(() => expect(events.map(e => e.outcome)).toEqual(["compacted"]))
    expect(events[0]).toMatchObject({ sessionId: id, pctBefore: 95, pctAfter: 10 })
    expect(reg.get(id)?.status).toBe("running")
  })

  it("announces a hard stop only when compaction did not bring the window down", async () => {
    const id = spawn(gatedHarness(95, 95, false))
    await reg.sendPrompt(id, "hello")
    await vi.waitFor(() => expect(events.map(e => e.outcome)).toEqual(["hard-stopped"]))
    expect(reg.get(id)?.status).toBe("killed")
  })

  it("holds direct prompts with a retryable mid-turn error and drains queued ones afterwards", async () => {
    const h = gatedHarness(95, 10, true)
    const id = spawn(h)
    await reg.sendPrompt(id, "hello")
    await vi.waitFor(() => expect(h.prompts.some(p => p.startsWith("/compact"))).toBe(true))

    await expect(reg.sendPrompt(id, "are you there?")).rejects.toThrow(/mid-turn/)
    const res = await reg.enqueuePrompt(id, "queued while compacting", { queue: true })
    expect(res).toMatchObject({ queued: true })

    h.releaseCompact()
    await vi.waitFor(() => expect(h.prompts.at(-1)).toBe("queued while compacting"))
    expect(reg.get(id)?.status).toBe("running")
    expect(events.map(e => e.outcome)).toEqual(["compacted"])
  })
})
