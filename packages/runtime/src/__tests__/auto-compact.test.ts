/**
 * Autocompact, the ABSOLUTE token threshold that compacts an idle
 * session's context (the percent ladder never fires on a 1M-token
 * window) and the short resume prompt that follows it.
 *
 * These tests are the contract:
 *   - the threshold is clamped (never rejected, never above the max)
 *   - autocompact fires only on an idle session above the threshold
 *   - it never fires twice while a compaction is in flight
 *   - the resume prompt is injected only when a mission is in progress
 */

import { describe, expect, it, vi } from "vitest"
import {
  AUTO_COMPACT_MIN_TOKENS,
  buildAutoCompactResumePrompt,
  clampAutoCompactTokens,
  createAutoCompactController,
  decideAutoCompact,
  effectiveAutoCompactTokens,
  type AutoCompactControllerDeps,
} from "../auto-compact.js"
import {
  CONTEXT_CONTINUITY_DEFAULTS,
  computeContextContinuityStatus,
  resolveContextContinuityPolicy,
} from "../context-continuity.js"

describe("clampAutoCompactTokens", () => {
  it("is disabled (0) when unset: autocompact is opt-in", () => {
    expect(clampAutoCompactTokens(undefined)).toBe(0)
    expect(clampAutoCompactTokens(null)).toBe(0)
    expect(clampAutoCompactTokens(Number.NaN)).toBe(0)
  })

  it("has no 200k ceiling: a 1M-window session can set a higher threshold", () => {
    expect(clampAutoCompactTokens(200_001)).toBe(200_001)
    expect(clampAutoCompactTokens(800_000)).toBe(800_000)
  })

  it("clamps a value below the floor up to the floor", () => {
    expect(clampAutoCompactTokens(1)).toBe(AUTO_COMPACT_MIN_TOKENS)
    expect(clampAutoCompactTokens(AUTO_COMPACT_MIN_TOKENS)).toBe(AUTO_COMPACT_MIN_TOKENS)
  })

  it("treats 0 (and negatives) as disabled", () => {
    expect(clampAutoCompactTokens(0)).toBe(0)
    expect(clampAutoCompactTokens(-1)).toBe(0)
  })

  it("keeps a value inside the range", () => {
    expect(clampAutoCompactTokens(90_000)).toBe(90_000)
  })
})

describe("decideAutoCompact", () => {
  const base = {
    tokens: 200_000,
    threshold: 150_000,
    idle: true,
    backgroundTask: false,
    compacting: false,
  }

  it("triggers on an idle session above the threshold", () => {
    const decision = decideAutoCompact(base)
    expect(decision.trigger).toBe(true)
    expect(decision.reason).toBe("above-threshold")
    expect(decision.threshold).toBe(150_000)
  })

  it("does not trigger below the threshold", () => {
    const decision = decideAutoCompact({ ...base, tokens: 149_999 })
    expect(decision.trigger).toBe(false)
    expect(decision.reason).toBe("below-threshold")
  })

  it("does not trigger on a busy session", () => {
    const decision = decideAutoCompact({ ...base, idle: false })
    expect(decision.trigger).toBe(false)
    expect(decision.reason).toBe("not-idle")
  })

  it("does not trigger while a background task is outstanding", () => {
    const decision = decideAutoCompact({ ...base, backgroundTask: true })
    expect(decision.trigger).toBe(false)
    expect(decision.reason).toBe("background-task")
  })

  it("does not trigger while a compaction is already in flight", () => {
    const decision = decideAutoCompact({ ...base, compacting: true })
    expect(decision.trigger).toBe(false)
    expect(decision.reason).toBe("already-compacting")
  })

  it("does not trigger when the token count is unknown", () => {
    const decision = decideAutoCompact({ ...base, tokens: undefined })
    expect(decision.trigger).toBe(false)
    expect(decision.reason).toBe("unknown-tokens")
  })

  it("does not trigger when the threshold is disabled (0)", () => {
    const decision = decideAutoCompact({ ...base, threshold: 0 })
    expect(decision.trigger).toBe(false)
    expect(decision.reason).toBe("disabled")
  })

  it("fires on a 1M-token window: the threshold is absolute, not a percent", () => {
    // 558k of a 1M window is 55%, the warn band of the percent ladder.
    const decision = decideAutoCompact({ ...base, tokens: 558_000 })
    expect(decision.trigger).toBe(true)
  })
})

function deps(overrides: Partial<AutoCompactControllerDeps> = {}): AutoCompactControllerDeps {
  return {
    readTokens: () => 200_000,
    readThreshold: () => 150_000,
    isIdle: () => true,
    hasBackgroundTask: () => false,
    isCompacting: () => false,
    requestCompact: async () => ({ missionInProgress: false }),
    requestResume: async () => undefined,
    transcriptPath: () => "/tmp/sessions/sess_1/events.jsonl",
    ...overrides,
  }
}

describe("createAutoCompactController", () => {
  it("compacts an idle session above the threshold", async () => {
    const requestCompact = vi.fn(async () => ({ missionInProgress: false }))
    const controller = createAutoCompactController(deps({ requestCompact }))
    const decision = await controller.maybeTrigger()
    expect(decision.trigger).toBe(true)
    expect(requestCompact).toHaveBeenCalledTimes(1)
  })

  it("does not compact a busy session", async () => {
    const requestCompact = vi.fn(async () => ({ missionInProgress: false }))
    const controller = createAutoCompactController(
      deps({ requestCompact, isIdle: () => false }),
    )
    const decision = await controller.maybeTrigger()
    expect(decision.trigger).toBe(false)
    expect(requestCompact).not.toHaveBeenCalled()
  })

  it("does not compact twice while a compaction is in flight", async () => {
    let release: (() => void) | undefined
    const gate = new Promise<void>(resolve => {
      release = resolve
    })
    const requestCompact = vi.fn(async () => {
      await gate
      return { missionInProgress: false }
    })
    const controller = createAutoCompactController(deps({ requestCompact }))
    const first = controller.maybeTrigger()
    // The second check runs while the first compaction is still running.
    const second = await controller.maybeTrigger()
    expect(second.trigger).toBe(false)
    expect(second.reason).toBe("already-compacting")
    release?.()
    await first
    expect(requestCompact).toHaveBeenCalledTimes(1)
  })

  it("injects the resume prompt only when a mission is in progress", async () => {
    const requestResume = vi.fn(async (_prompt: string) => undefined)
    const controller = createAutoCompactController(
      deps({
        requestCompact: async () => ({ missionInProgress: true, goal: "ship the PR" }),
        requestResume,
      }),
    )
    await controller.maybeTrigger()
    expect(requestResume).toHaveBeenCalledTimes(1)
    const prompt = requestResume.mock.calls[0]![0] as string
    expect(prompt).toContain("ship the PR")
    expect(prompt).toContain("/tmp/sessions/sess_1/events.jsonl")
  })

  it("does not inject a resume prompt without a mission", async () => {
    const requestResume = vi.fn(async (_prompt: string) => undefined)
    const controller = createAutoCompactController(
      deps({
        requestCompact: async () => ({ missionInProgress: false }),
        requestResume,
      }),
    )
    await controller.maybeTrigger()
    expect(requestResume).not.toHaveBeenCalled()
  })

  it("does not compact again until the context has dropped below the threshold", async () => {
    // A harness that reports an unchanged usage figure after the
    // compaction must not put the session into a compaction loop.
    const requestCompact = vi.fn(async () => ({ missionInProgress: false }))
    const controller = createAutoCompactController(deps({ requestCompact }))
    await controller.maybeTrigger()
    const second = await controller.maybeTrigger()
    expect(second.trigger).toBe(false)
    expect(second.reason).toBe("awaiting-drop")
    expect(requestCompact).toHaveBeenCalledTimes(1)
  })

  it("re-arms once the context has dropped below the threshold", async () => {
    let tokens = 200_000
    const requestCompact = vi.fn(async () => {
      tokens = 1_000
      return { missionInProgress: false }
    })
    const controller = createAutoCompactController(
      deps({ requestCompact, readTokens: () => tokens }),
    )
    await controller.maybeTrigger()
    // The post-compaction reading is below the threshold: nothing to do.
    const settled = await controller.maybeTrigger()
    expect(settled.trigger).toBe(false)
    expect(settled.reason).toBe("below-threshold")
    // Once the context regrows past the threshold, it compacts again.
    tokens = 200_000
    const second = await controller.maybeTrigger()
    expect(second.trigger).toBe(true)
    expect(requestCompact).toHaveBeenCalledTimes(2)
  })

  it("stays disarmed on regrowth smaller than the growth delta, re-arms at it", async () => {
    // Threshold 150k → growth delta is 25% of it (37.5k). The compaction
    // leaves usage above the threshold (floor = 160k).
    let tokens = 200_000
    const requestCompact = vi.fn(async () => {
      tokens = 160_000
      return { missionInProgress: false }
    })
    const controller = createAutoCompactController(
      deps({ requestCompact, readTokens: () => tokens }),
    )
    await controller.maybeTrigger()
    expect(requestCompact).toHaveBeenCalledTimes(1)

    // Unchanged usage after the compaction does not loop.
    const unchanged = await controller.maybeTrigger()
    expect(unchanged.trigger).toBe(false)
    expect(unchanged.reason).toBe("awaiting-drop")

    // One token short of the growth delta: still disarmed.
    tokens = 160_000 + 37_499
    const short = await controller.maybeTrigger()
    expect(short.trigger).toBe(false)
    expect(short.reason).toBe("awaiting-drop")
    expect(requestCompact).toHaveBeenCalledTimes(1)

    // At the growth delta: re-armed and compacts again.
    tokens = 160_000 + 37_500
    const rearmed = await controller.maybeTrigger()
    expect(rearmed.trigger).toBe(true)
    expect(requestCompact).toHaveBeenCalledTimes(2)
  })

  it("clears the floor on re-arm so the next compaction measures growth afresh", async () => {
    let tokens = 160_000
    const requestCompact = vi.fn(async () => ({ missionInProgress: false }))
    const controller = createAutoCompactController(
      deps({ requestCompact, readTokens: () => tokens }),
    )
    await controller.maybeTrigger() // compacts, floor = 160k
    tokens = 200_000 // 160k + 40k >= growth delta: re-arms
    await controller.maybeTrigger()
    expect(requestCompact).toHaveBeenCalledTimes(2)
    // The new floor is 200k (the post-compaction reading), not the stale
    // 160k: a modest bump does not re-arm, and unchanged usage does not loop.
    const unchanged = await controller.maybeTrigger()
    expect(unchanged.reason).toBe("awaiting-drop")
    tokens = 210_000
    const small = await controller.maybeTrigger()
    expect(small.reason).toBe("awaiting-drop")
    expect(requestCompact).toHaveBeenCalledTimes(2)
  })

  it("never throws when the compaction fails", async () => {
    const controller = createAutoCompactController(
      deps({
        requestCompact: async () => {
          throw new Error("boom")
        },
      }),
    )
    await expect(controller.maybeTrigger()).resolves.toBeDefined()
  })
})

describe("buildAutoCompactResumePrompt", () => {
  it("cites the full transcript path", () => {
    const prompt = buildAutoCompactResumePrompt({
      goal: "finish the migration",
      transcriptPath: "/home/u/.agentproto/sessions/sess_x/events.jsonl",
    })
    expect(prompt).toContain("/home/u/.agentproto/sessions/sess_x/events.jsonl")
    expect(prompt).toContain("finish the migration")
  })

  it("omits the mission line when there is no goal", () => {
    const prompt = buildAutoCompactResumePrompt({ transcriptPath: "/tmp/e.jsonl" })
    expect(prompt).not.toContain("Mission:")
    expect(prompt).toContain("/tmp/e.jsonl")
  })
})

describe("context-continuity policy", () => {
  it("ships no default threshold: autocompact is off unless a policy sets one", () => {
    expect(CONTEXT_CONTINUITY_DEFAULTS.autoCompactAtTokens).toBeUndefined()
    const resolved = resolveContextContinuityPolicy(undefined, undefined, undefined, undefined)
    expect(effectiveAutoCompactTokens(resolved)).toBe(0)
  })

  it("keeps a large threshold and clamps only below the floor", () => {
    const big = resolveContextContinuityPolicy(
      { autoCompactAtTokens: 999_999 },
      undefined,
      undefined,
      undefined,
    )
    expect(big.autoCompactAtTokens).toBe(999_999)
    const tiny = resolveContextContinuityPolicy({ autoCompactAtTokens: 5 }, undefined, undefined, undefined)
    expect(tiny.autoCompactAtTokens).toBe(AUTO_COMPACT_MIN_TOKENS)
  })

  it("mode manual disables autocompact", () => {
    expect(effectiveAutoCompactTokens({ mode: "manual", autoCompactAtTokens: 150_000 })).toBe(0)
    expect(effectiveAutoCompactTokens({ mode: "ask", autoCompactAtTokens: 150_000 })).toBe(150_000)
    expect(effectiveAutoCompactTokens({ mode: "auto", autoCompactAtTokens: 150_000 })).toBe(150_000)
    expect(effectiveAutoCompactTokens({ mode: "ask" })).toBe(0)
    expect(effectiveAutoCompactTokens(undefined)).toBe(0)
  })

  it("lets a session override the threshold", () => {
    const resolved = resolveContextContinuityPolicy(
      { autoCompactAtTokens: 150_000 },
      undefined,
      undefined,
      { autoCompactAtTokens: 42_000 },
    )
    expect(resolved.autoCompactAtTokens).toBe(42_000)
  })
})

describe("session_context_status", () => {
  it("reports the absolute threshold and whether the session is above it", () => {
    const policy = resolveContextContinuityPolicy(
      { autoCompactAtTokens: 150_000 },
      undefined,
      undefined,
      undefined,
    )
    const below = computeContextContinuityStatus("sess_1", policy, 1_000_000, 100_000)
    expect(below.autoCompactAtTokens).toBe(150_000)
    expect(below.autoCompactAboveThreshold).toBe(false)

    const above = computeContextContinuityStatus("sess_1", policy, 1_000_000, 200_000)
    expect(above.autoCompactAboveThreshold).toBe(true)
    // The percent ladder still says "ok" at 20%, that is the bug the
    // absolute threshold exists to cover.
    expect(above.state).toBe("ok")
  })

  it("reports 0 / not above for a session without a threshold or in manual mode", () => {
    const none = resolveContextContinuityPolicy(undefined, undefined, undefined, undefined)
    const status = computeContextContinuityStatus("sess_1", none, 1_000_000, 900_000)
    expect(status.autoCompactAtTokens).toBe(0)
    expect(status.autoCompactAboveThreshold).toBe(false)

    const manual = resolveContextContinuityPolicy(
      { mode: "manual", autoCompactAtTokens: 150_000 },
      undefined,
      undefined,
      undefined,
    )
    const m = computeContextContinuityStatus("sess_1", manual, 1_000_000, 200_000)
    expect(m.autoCompactAtTokens).toBe(0)
    expect(m.autoCompactAboveThreshold).toBe(false)
  })
})
