/**
 * The context window a session reports must not flip back to an adapter's
 * INFERRED size once an authoritative one is known.
 *
 * Replays the shape recorded in real claude-code sessions (daemon 0.21.5,
 * claude-agent-acp 0.75.1 / 0.81.2 — e.g. sess_a4a2a3fb): every in-turn
 * `usage_update` carries `size: 200000` (the wrapper's text heuristic for a
 * bare "claude-opus-5-5"), and only the end-of-turn, cost-bearing frame
 * carries the real 1M from `result.modelUsage`. A fresh wrapper (resume,
 * daemon restart) starts guessing 200k again, which is what turn 2 below
 * simulates.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createSessionsRegistry, type AgentSessionLike, type AgentStreamEvent } from "../sessions.js"
import { createSessionEventBus } from "../session-event-bus.js"
import { sessionEventsPath } from "../transcript-writer.js"
import {
  CONTEXT_CONTINUITY_DEFAULTS,
  computeContextContinuityStatus,
} from "../context-continuity.js"
import {
  catalogContextWindow,
  foldUsageFrameWindow,
  resetContextWindowForModel,
  type ContextWindowState,
} from "../context-window.js"

const INFERRED = 200_000
const REAL = 1_000_000
const cost = (amount: number) => ({ amount, currency: "USD" })

/** One recorded turn: N inferred in-turn frames, then the authoritative one.
 *  Frames are shaped as the ACP client emits them (`sizeInferred` on the
 *  wrapper's cost-less frames). */
function recordedTurn(usedFrom: number, usedTo: number, frames: number, model?: string): AgentStreamEvent[] {
  const events: AgentStreamEvent[] = []
  for (let i = 0; i < frames; i++) {
    const used = Math.round(usedFrom + ((usedTo - usedFrom) * i) / frames)
    events.push({ kind: "usage_update", size: INFERRED, used, sizeInferred: true, ...(model ? { model } : {}) })
  }
  events.push({ kind: "usage_update", size: REAL, used: usedTo, cost: cost(1.5), ...(model ? { model } : {}) })
  return events
}

/** Fake agent that replays one recorded turn per prompt and notes the
 *  descriptor's contextSize after each frame was ingested. */
function replayAgent(
  turns: AgentStreamEvent[][],
  observe: () => number | undefined,
  seen: Array<number | undefined>,
): AgentSessionLike {
  let turn = 0
  return {
    sessionId: "replay-acp",
    async *send() {
      const events = turns[turn++] ?? []
      for (const evt of events) {
        yield evt
        // The consumer projects an event before pulling the next one.
        seen.push(observe())
      }
      yield { kind: "turn-end" }
    },
    async cancel() {},
    async close() {},
  }
}

function readUsageUpdates(path: string): Array<Record<string, unknown>> {
  if (!existsSync(path)) return []
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map(line => JSON.parse(line) as Record<string, unknown>)
    .filter(r => r.kind === "usage_update")
}

async function pollUsageUpdates(path: string, count: number): Promise<Array<Record<string, unknown>>> {
  for (let attempt = 0; attempt < 80; attempt++) {
    const rows = readUsageUpdates(path)
    if (rows.length >= count) return rows
    await new Promise(r => setTimeout(r, 25))
  }
  return readUsageUpdates(path)
}

describe("foldUsageFrameWindow", () => {
  it("keeps an authoritative (cost-bearing) size over later inferred frames", () => {
    const state: ContextWindowState = {}
    expect(foldUsageFrameWindow(state, { size: INFERRED, sizeInferred: true })).toBe(INFERRED)
    expect(state.contextSizeSource).toBe("reported")
    expect(foldUsageFrameWindow(state, { size: REAL, cost: cost(1) })).toBe(REAL)
    expect(state.contextSizeSource).toBe("adapter")
    expect(foldUsageFrameWindow(state, { size: INFERRED, sizeInferred: true })).toBe(REAL)
    // Sticky against any cost-less frame, inferred or not.
    expect(foldUsageFrameWindow(state, { size: INFERRED })).toBe(REAL)
    expect(state).toEqual({ contextSize: REAL, contextSizeSource: "adapter" })
  })

  it("lets a newer authoritative frame replace an older one", () => {
    const state: ContextWindowState = { contextSize: REAL, contextSizeSource: "adapter" }
    expect(foldUsageFrameWindow(state, { size: INFERRED, cost: cost(1) })).toBe(INFERRED)
    expect(state.contextSizeSource).toBe("adapter")
  })

  it("prefers the catalog over an inferred frame, from the frame's model or the session's", () => {
    const fromFrame: ContextWindowState = {}
    expect(foldUsageFrameWindow(fromFrame, { size: INFERRED, sizeInferred: true, model: "claude-sonnet-5" })).toBe(REAL)
    expect(fromFrame.contextSizeSource).toBe("catalog")
    const fromSession: ContextWindowState = {}
    expect(foldUsageFrameWindow(fromSession, { size: INFERRED, sizeInferred: true }, "claude-opus-5-5")).toBe(REAL)
  })

  it("trusts a non-inferred frame over the catalog (an adapter running below the catalog window)", () => {
    // hermes/kimi: the harness caps the window under the model's catalog 262k.
    const state: ContextWindowState = {}
    resetContextWindowForModel(state, "moonshotai/kimi-k2.7-code")
    expect(state).toEqual({ contextSize: 262_144, contextSizeSource: "catalog" })
    expect(foldUsageFrameWindow(state, { size: INFERRED }, "moonshotai/kimi-k2.7-code")).toBe(INFERRED)
    expect(state.contextSizeSource).toBe("reported")
  })

  it("honours an explicit [1m] lane hint on the session model over the bare frame model", () => {
    const state: ContextWindowState = {}
    // claude-haiku-4-5 is 200k in the catalog; the hint names the 1M lane.
    expect(
      foldUsageFrameWindow(state, { size: INFERRED, sizeInferred: true, model: "claude-haiku-4-5" }, "claude-haiku-4-5[1m]"),
    ).toBe(REAL)
  })

  it("ignores size 0 (no window reported) and is idempotent", () => {
    const state: ContextWindowState = { contextSize: REAL, contextSizeSource: "catalog" }
    expect(foldUsageFrameWindow(state, { size: 0, cost: cost(1) })).toBe(REAL)
    expect(state.contextSizeSource).toBe("catalog")
    const size = foldUsageFrameWindow(state, { size: INFERRED, sizeInferred: true }, "claude-opus-5")
    expect(size).toBe(REAL)
    expect(foldUsageFrameWindow(state, { size, sizeInferred: true }, "claude-opus-5")).toBe(size)
  })

  it("falls back to the reported size for a model the catalog doesn't know", () => {
    const state: ContextWindowState = {}
    expect(foldUsageFrameWindow(state, { size: 128_000, sizeInferred: true }, "totally-unknown-model-zzz")).toBe(128_000)
    expect(state.contextSizeSource).toBe("reported")
  })
})

describe("catalogContextWindow / resetContextWindowForModel", () => {
  it("knows the 1M Claude 5 models in every spelling a session carries", () => {
    for (const id of [
      "claude-opus-5-5",
      "claude-sonnet-5",
      "claude-opus-5",
      "claude-opus-5-5[1m]",
      "anthropic/claude-opus-5-5",
      "anthropic/claude-sonnet-5@openrouter",
    ]) {
      expect(catalogContextWindow(id), id).toBe(REAL)
    }
    expect(catalogContextWindow("claude-haiku-4-5")).toBe(INFERRED)
    expect(catalogContextWindow("totally-unknown-model-zzz")).toBeUndefined()
    expect(catalogContextWindow(undefined)).toBeUndefined()
  })

  it("drops a sticky adapter window on model switch", () => {
    const state: ContextWindowState = { contextSize: REAL, contextSizeSource: "adapter" }
    resetContextWindowForModel(state, "claude-haiku-4-5")
    expect(state).toEqual({ contextSize: INFERRED, contextSizeSource: "catalog" })
    // Unknown model: keep the figure but let the next frame replace it.
    resetContextWindowForModel(state, "totally-unknown-model-zzz")
    expect(state.contextSizeSource).toBe("reported")
    expect(foldUsageFrameWindow(state, { size: 64_000 })).toBe(64_000)
  })
})

describe("registry replay of recorded claude-code usage_update frames", () => {
  let transcriptDir: string
  beforeEach(() => {
    transcriptDir = mkdtempSync(join(tmpdir(), "ctx-window-sticky-"))
  })
  afterEach(() => {
    rmSync(transcriptDir, { recursive: true, force: true })
  })

  // Turn 1 as recorded (sess_a4a2a3fb); turn 2 as a fresh wrapper replays it
  // (inferred 200k frames again, well past 200k * 55% = warn).
  const turns = () => [recordedTurn(38_242, 157_053, 12), recordedTurn(157_257, 159_326, 6)]

  it("no model pinned: 1M sticks after the first authoritative frame; thresholds use it", async () => {
    const registry = createSessionsRegistry({
      persist: false,
      transcriptDir,
      sessionEvents: createSessionEventBus(),
    })
    const seen: Array<number | undefined> = []
    let id = ""
    const desc = registry.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: replayAgent(turns(), () => registry.get(id)?.contextSize, seen),
      adapterSlug: "claude-code",
      contextContinuity: CONTEXT_CONTINUITY_DEFAULTS,
    })
    id = desc.id

    await registry.sendPrompt(id, "turn 1")
    // Nothing to go on but the frames during turn 1 — then the real window.
    expect(seen.slice(0, 12)).toEqual(Array(12).fill(INFERRED))
    expect(seen[12]).toBe(REAL)

    await registry.sendPrompt(id, "turn 2")
    // Turn 2's inferred frames no longer downgrade it.
    expect(seen.slice(13)).toEqual(Array(7).fill(REAL))

    const after = registry.get(id)!
    expect(after.contextSize).toBe(REAL)
    expect(after.contextSizeSource).toBe("adapter")
    expect(after.contextUsed).toBe(159_326)
    // ~16% of 1M — context-continuity stays quiet (at 200k it'd read 80%:
    // past continue-fresh, one step off the hard stop).
    const status = computeContextContinuityStatus(id, CONTEXT_CONTINUITY_DEFAULTS, after.contextSize, after.contextUsed)
    expect(status.contextPct).toBe(16)
    expect(status.state).toBe("ok")
    expect(after.awaitingQuestion).toBeUndefined()
    expect(after.contextContinuityHardStopped).toBeFalsy()

    // The durable transcript carries the corrected size, with the adapter's
    // own figure kept alongside for turn 2's downgraded frames.
    const frames = await pollUsageUpdates(sessionEventsPath(id, transcriptDir), 20)
    const turn2 = frames.slice(13)
    expect(turn2.every(f => f.size === REAL)).toBe(true)
    expect(turn2.filter(f => f.reportedSize === INFERRED)).toHaveLength(6)

    registry.shutdown()
  })

  it("model pinned to claude-opus-5-5: the catalog seeds 1M before the first result", async () => {
    const registry = createSessionsRegistry({
      persist: false,
      transcriptDir,
      sessionEvents: createSessionEventBus(),
    })
    const seen: Array<number | undefined> = []
    let id = ""
    const desc = registry.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: replayAgent(turns(), () => registry.get(id)?.contextSize, seen),
      adapterSlug: "claude-code",
      model: "claude-opus-5-5",
      contextContinuity: CONTEXT_CONTINUITY_DEFAULTS,
    })
    id = desc.id
    expect(desc.contextSize).toBe(REAL)
    expect(desc.contextSizeSource).toBe("catalog")

    await registry.sendPrompt(id, "turn 1")
    await registry.sendPrompt(id, "turn 2")
    expect(seen).toEqual(Array(20).fill(REAL))
    expect(registry.get(id)?.awaitingQuestion).toBeUndefined()

    const frames = await pollUsageUpdates(sessionEventsPath(id, transcriptDir), 20)
    expect(frames.every(f => f.size === REAL)).toBe(true)

    registry.shutdown()
  })

  it("alias session (no pinned id): the wrapper's _claude/model on the frame seeds the catalog", async () => {
    const registry = createSessionsRegistry({
      persist: false,
      transcriptDir,
      sessionEvents: createSessionEventBus(),
    })
    const seen: Array<number | undefined> = []
    let id = ""
    const desc = registry.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: replayAgent(
        [recordedTurn(25_289, 67_215, 5, "claude-sonnet-5")],
        () => registry.get(id)?.contextSize,
        seen,
      ),
      adapterSlug: "claude-code",
    })
    id = desc.id
    await registry.sendPrompt(id, "turn 1")
    expect(seen).toEqual(Array(6).fill(REAL))

    registry.shutdown()
  })
})
