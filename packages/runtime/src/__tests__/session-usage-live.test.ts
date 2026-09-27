/**
 * Live session cost-gaps — regression tests for the "session shows NO cost"
 * class of bugs reported against the THREE live-adapters shapes:
 *
 *   1. hermes: its ACP server streams NO usage frames at all and its
 *      `readUsage` hook (the state.db reader) was polled only per turn-end,
 *      so a live session never showed a cost (the observed hermes executor
 *      session carried its first — and only — `usage_update` together with
 *      its single aborted turn-end, ~30 min after spawn).
 *   2. claude-code: usage frames ARE streamed in-turn, but cost-less
 *      (tokens-in-context `used` only; the wrapper's cost frame lands at
 *      cycle end), so a long first turn showed no cost the whole time.
 *   3. opencode: between turn-ends nothing arrives (its cost+tokens ride the
 *      state store via `readUsage`), and in-turn frames carry no cost either.
 *
 * Two mechanisms under test:
 *   - `armUsageRefresh` polls a reader-equipped session every
 *     USAGE_REFRESH_INTERVAL_MS (test-overridable) and mirrors changed
 *     readings via `applyUsageRead` (deduped);
 *   - `projectEvent`'s usage_update case derives a running `source:"computed"`
 *     cost from a cast frame's cumulative token counts while no adapter cost
 *     has EVER arrived, and the adapter cost replaces it without summing.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createSessionsRegistry, USAGE_REFRESH_INTERVAL_MS, type AgentSessionLike, type AgentStreamEvent } from "../sessions.js"
import { sessionEventsPath } from "../transcript-writer.js"

const POLL_MS = 20

function transcriptUsageUpdates(
  path: string,
): Array<Record<string, unknown>> {
  if (!existsSync(path)) return []
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map(line => JSON.parse(line) as Record<string, unknown>)
    .filter(r => r.kind === "usage_update")
}

/** hermes shape: no usage over the wire at all, a silent turn that stays
 *  open until the test releases it. */
function gatedAgent(): { session: AgentSessionLike; release: () => void } {
  let release!: () => void
  const gate = new Promise<void>(r => { release = r })
  return {
    release,
    session: {
      sessionId: "hermes-live-sess",
      async *send() {
        yield { kind: "text-delta", text: "working\n" }
        await gate
        yield { kind: "turn-end", reason: "completed" }
      },
      async cancel() {},
      async close() {},
    },
  }
}

/** claude-code shape: cost-less `used` frames streaming in-turn, then a
 *  cost-bearing result frame when the cycle ends. */
function claudeCodeAgent(): { session: AgentSessionLike; release: () => void } {
  let release!: () => void
  const gate = new Promise<void>(r => { release = r })
  const frame = (used: number, cost?: { amount: number; currency: string }): AgentStreamEvent => ({
    kind: "usage_update",
    size: 200_000,
    used,
    ...(cost ? { cost } : {}),
    model: "claude-sonnet-4-5",
  })
  return {
    release,
    session: {
      sessionId: "claude-code-sess",
      async *send() {
        yield frame(22_510)
        yield frame(45_525)
        await gate
        yield frame(45_525, { amount: 0.9, currency: "USD" })
        yield { kind: "turn-end", reason: "completed" }
      },
      async cancel() {},
      async close() {},
    },
  }
}

/** opencode shape: silent on the wire while busy; cost+tokens only ever
 *  arrive out-of-band through the `readUsage` hook (its state store). */
function silentAgent(): AgentSessionLike {
  return {
    sessionId: "opencode-live-sess",
    async *send() {
      yield { kind: "text-delta", text: "done\n" }
      yield { kind: "turn-end", reason: "completed" }
    },
    async cancel() {},
    async close() {},
  }
}

describe("live session usage refresh", () => {
  let tmp: string
  let transcriptDir: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "usage-live-test-"))
    transcriptDir = join(tmp, "sessions")
  })

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  function makeRegistry() {
    return createSessionsRegistry({
      persist: false,
      transcriptDir,
      usageRefreshIntervalMs: POLL_MS,
    })
  }

  it("hermes live: the readUsage poller mirrors cost+tokens onto the descriptor mid-turn with no wire frames", async () => {
    const gated = gatedAgent()
    // state.db shape: cost lands only after the CLI's next store write —
    // the first poll finds nothing, the second one finds the numbers.
    let pollCount = 0
    const registry = makeRegistry()
    const desc = registry.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: gated.session,
      adapterSlug: "hermes",
      model: "z-ai/glm-5.3-flash",
      // Same turn gating as hermes' real executor session: one turn, minutes long.
      readUsage: async () => {
        pollCount += 1
        return pollCount >= 2 ? { costUsd: 0.11, tokensIn: 172_856, tokensOut: 52_249 } : null
      },
      initialPrompt: "do a long turn",
    })

    // Before the reader has anything: no cost surfaced.
    expect(registry.get(desc.id)?.costUsd).toBeUndefined()

    // Let the poller tick twice (empty read, populated read).
    await new Promise(r => setTimeout(r, POLL_MS * 2 + 60))
    await new Promise(r => setTimeout(r, 25))

    const live = registry.get(desc.id)
    expect(live?.costUsd).toBe(0.11)
    expect(live?.tokensIn).toBe(172_856)
    expect(live?.tokensOut).toBe(52_249)
    expect(live?.usageSource).toBe("adapter")
    expect(live?.busy).toBe(true) // turn still in flight — this WAS live

    // The transcript carries the mid-turn usage_update like a turn-end one.
    const updates = transcriptUsageUpdates(sessionEventsPath(desc.id, transcriptDir))
    expect(updates.length).toBe(1) // deduped: identical reads write nothing
    expect(updates[0]).toMatchObject({ cost: { amount: 0.11, currency: "USD" }, tokensIn: 172_856 })

    gated.release()
    await new Promise(r => setTimeout(r, 25))
    registry.shutdown()
  })

  it("hermes live: a changed reading is mirrored again (no dedupe of real news)", async () => {
    const gated = gatedAgent()
    let pollCount = 0
    const registry = makeRegistry()
    const desc = registry.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: gated.session,
      adapterSlug: "hermes",
      model: "z-ai/glm-5.3-flash",
      // Every tick has new work → strictly increasing cost, so every changed
      // reading must land (and identical ones would dedupe). No dependence on
      // exact poll cadence: only "several ticks happened".
      readUsage: async () => {
        pollCount += 1
        return { costUsd: 0.01 * pollCount, tokensIn: 1_000 + pollCount, tokensOut: 500 }
      },
      initialPrompt: "long turn",
    })

    await new Promise(r => setTimeout(r, POLL_MS * 8 + 200))

    const live = registry.get(desc.id)
    // The first read may land as 0.01; several more ticks must have applied —
    // so the live figure strictly advanced beyond the first reading.
    expect(live?.costUsd).toBeGreaterThan(0.01)
    expect(live?.tokensIn).toBeGreaterThan(1_000)

    const updates = transcriptUsageUpdates(sessionEventsPath(desc.id, transcriptDir))
    // One recording per DISTINCT content — none wasted on repeats.
    expect(updates.length).toBeGreaterThanOrEqual(2)
    const amounts = updates.map(
      u => (u.cost as { amount: number }).amount,
    )
    expect(amounts[amounts.length - 1]).toBeGreaterThan(amounts[0]!)

    gated.release()
    await new Promise(r => setTimeout(r, 25))
    registry.shutdown()
  })

  it("claude-code mid-first-turn: costless `used` frames yield a running computed cost; the result frame's adapter cost REPLACES it", async () => {
    const gated = claudeCodeAgent()
    const registry = makeRegistry()
    const desc = registry.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: gated.session,
      adapterSlug: "claude-code",
      model: "claude-sonnet-4-5",
      initialPrompt: "long first turn",
    })
    // Let the two cost-less frames stream.
    await new Promise(r => setTimeout(r, 50))

    const midTurn = registry.get(desc.id)
    expect(midTurn?.busy).toBe(true)
    expect(midTurn?.usageSource).toBe("computed")
    // 45_525 input tokens at $3/1M (claude-sonnet-4-5 in-repo catalog price).
    expect(midTurn?.costUsd).toBeCloseTo((45_525 * 3) / 1_000_000, 10)

    // The turn ends with a cost-bearing result frame → adapter cost wins,
    // replacing (not adding to) the estimate.
    gated.release()
    await new Promise(r => setTimeout(r, 100))
    const ended = registry.get(desc.id)
    expect(ended?.usageSource).toBe("adapter")
    expect(ended?.costUsd).toBe(0.9)

    registry.shutdown()
  })

  it("opencode live: no in-turn frames at all, cost+tokens ride the polled reader", async () => {
    const registry = makeRegistry()
    let pollCount = 0
    const desc = registry.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: silentAgent(),
      adapterSlug: "opencode",
      model: "opencode-go/glm-5.3-flash",
      readUsage: async () => {
        pollCount += 1
        return pollCount >= 2
          ? { costUsd: 0.07241664, tokensIn: 112_016, tokensOut: 6_453 }
          : null
      },
      initialPrompt: "quiet turn",
    })

    // After the turn already ended once with the reader empty, a later turn's
    // live poll must still land cost+tokens on the descriptor.
    await new Promise(r => setTimeout(r, POLL_MS * 2 + 60))
    await new Promise(r => setTimeout(r, 25))

    const live = registry.get(desc.id)
    expect(live?.costUsd).toBe(0.07241664)
    expect(live?.tokensIn).toBe(112_016)
    expect(live?.tokensOut).toBe(6_453)

    const updates = transcriptUsageUpdates(sessionEventsPath(desc.id, transcriptDir))
    expect(updates.length).toBe(1)

    // The turn-end path wrote its (early, reader-empty) recap, and the live
    // poller later rewrote a corrected adapter-priced one.
    for (let attempt = 0; attempt < 40; attempt++) {
      if (existsSync(sessionEventsPath(desc.id, transcriptDir))) {
        const snaps = readFileSync(sessionEventsPath(desc.id, transcriptDir), "utf8")
          .split("\n").filter(Boolean)
          .map(line => JSON.parse(line) as Record<string, unknown>)
          .filter(r => r.kind === "usage_snapshot")
        if (snaps.length > 0 && snaps[snaps.length - 1]!.source === "adapter") {
          expect(snaps[snaps.length - 1]).toMatchObject({ costUsd: 0.07241664 })
          break
        }
      }
      await new Promise(r => setTimeout(r, 25))
    }

    registry.shutdown()
  })

  it("opencode after turn-end: the readUsage cost block lands and stamps source=adapter (existing shape, spelled out)", async () => {
    const registry = makeRegistry()
    const desc = registry.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: silentAgent(),
      adapterSlug: "opencode",
      model: "opencode-go/glm-5.3-flash",
      readUsage: async () => ({ costUsd: 0.07241664, tokensIn: 112_016, tokensOut: 6_453 }),
      initialPrompt: "turn one",
    })
    await new Promise(r => setTimeout(r, 100))

    const ended = registry.get(desc.id)
    expect(ended?.usageSource).toBe("adapter")
    expect(ended?.costUsd).toBe(0.07241664)
    expect(ended?.tokensIn).toBe(112_016)

    registry.shutdown()
  })

  it("claude-code turn-end with tokens-only reader still derives computed cost at the boundary (no adapter cost anywhere)", async () => {
    // claude-code shape but the closing frame carries NO cost (a turn that
    // ended without its result frame), and an opencode-style reader reports
    // tokens WITHOUT a cost — the turn-end re-derivation must compute — and
    // stamp — from those tokens.
    let release!: () => void
    const gate = new Promise<void>(r => { release = r })
    const frame = (used: number): AgentStreamEvent => ({
      kind: "usage_update",
      size: 200_000,
      used,
      model: "claude-sonnet-4-5",
    })
    const registry = makeRegistry()
    const desc = registry.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: {
        sessionId: "claude-code-tok-sess",
        async *send() {
          yield frame(22_510)
          await gate
          yield frame(45_525)
          yield { kind: "turn-end", reason: "completed" }
        },
        async cancel() {},
        async close() {},
      },
      adapterSlug: "claude-code",
      model: "claude-sonnet-4-5",
      readUsage: async () => ({ tokensIn: 112_016, tokensOut: 6_453 }),
      initialPrompt: "tokens without cost",
    })

    await new Promise(r => setTimeout(r, 50))
    expect(registry.get(desc.id)?.usageSource).toBe("computed")

    release()
    await new Promise(r => setTimeout(r, 150))
    expect(registry.get(desc.id)?.usageSource).toBe("computed")
    expect(registry.get(desc.id)?.costUsd).toBeCloseTo(
      (112_016 * 3 + 6_453 * 15) / 1_000_000, 6,
    )

    registry.shutdown()
  })

  it("no cost is fabricated for an unpriced model mid-turn", async () => {
    const gated = gatedAgent()
    const registry = makeRegistry()
    const desc = registry.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: {
        ...gated.session,
        async *send() {
          yield {
            kind: "usage_update",
            size: 200_000,
            used: 22_000,
            model: "totally-unknown-model-zzz",
          } as AgentStreamEvent
          await new Promise(r => setTimeout(r, 50))
          yield { kind: "turn-end", reason: "completed" }
        },
      },
      adapterSlug: "claude-code",
      model: "totally-unknown-model-zzz",
      initialPrompt: "unpriced",
    })
    await new Promise(r => setTimeout(r, 100))

    const live = registry.get(desc.id)
    // Unpriced model → never a fabricated figure; with no cumulative token
    // pair and no adapter cost the snapshot is honestly "none".
    expect(live?.usageSource).toBe("none")
    expect(live?.costUsd).toBeUndefined()

    gated.release()
    await new Promise(r => setTimeout(r, 25))
    registry.shutdown()
  })

  it("the kill path disarms the poller — no read after a kill", async () => {
    const gated = gatedAgent()
    let reads = 0
    const registry = makeRegistry()
    const desc = registry.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: gated.session,
      adapterSlug: "hermes",
      model: "z-ai/glm-5.3-flash",
      readUsage: async () => {
        reads += 1
        return null
      },
      initialPrompt: "work",
    })
    await new Promise(r => setTimeout(r, POLL_MS + 40))
    const readsBeforeKill = reads
    expect(readsBeforeKill).toBeGreaterThanOrEqual(1)

    registry.kill(desc.id)
    const readsAfterKill = reads
    await new Promise(r => setTimeout(r, POLL_MS * 2 + 50))
    expect(reads).toBe(readsAfterKill) // no more polling after death
    expect(readsAfterKill).toBeGreaterThanOrEqual(readsBeforeKill)

    gated.release()
    await new Promise(r => setTimeout(r, 25))
    registry.shutdown()
  })

  it("sanity: the exported production cadence is calm", () => {
    expect(USAGE_REFRESH_INTERVAL_MS).toBeGreaterThanOrEqual(3_000)
    expect(USAGE_REFRESH_INTERVAL_MS).toBeLessThanOrEqual(15_000)
  })
})
