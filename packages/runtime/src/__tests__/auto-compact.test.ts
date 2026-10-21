/**
 * Autocompact — the ABSOLUTE token threshold that compacts an idle
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
  AUTO_COMPACT_DEFAULT_TOKENS,
  AUTO_COMPACT_MAX_TOKENS,
  AUTO_COMPACT_MIN_TOKENS,
  buildAutoCompactResumePrompt,
  clampAutoCompactTokens,
  createAutoCompactController,
  decideAutoCompact,
  type AutoCompactControllerDeps,
} from "../auto-compact.js"
import {
  CONTEXT_CONTINUITY_DEFAULTS,
  resolveContextContinuityPolicy,
} from "../context-continuity.js"

describe("clampAutoCompactTokens", () => {
  it("defaults to 150k when unset", () => {
    expect(clampAutoCompactTokens(undefined)).toBe(AUTO_COMPACT_DEFAULT_TOKENS)
    expect(AUTO_COMPACT_DEFAULT_TOKENS).toBe(150_000)
  })

  it("clamps a value above the maximum down to 200k", () => {
    expect(clampAutoCompactTokens(500_000)).toBe(AUTO_COMPACT_MAX_TOKENS)
    expect(AUTO_COMPACT_MAX_TOKENS).toBe(200_000)
    expect(clampAutoCompactTokens(200_001)).toBe(200_000)
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
    // 558k of a 1M window is 55% — the warn band of the percent ladder.
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
    tokens = 200_000
    const second = await controller.maybeTrigger()
    expect(second.trigger).toBe(false)
    expect(second.reason).toBe("awaiting-drop")
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
  it("carries the autocompact threshold with the default", () => {
    expect(CONTEXT_CONTINUITY_DEFAULTS.autoCompactAtTokens).toBe(AUTO_COMPACT_DEFAULT_TOKENS)
  })

  it("clamps an out-of-range threshold instead of rejecting the policy", () => {
    const resolved = resolveContextContinuityPolicy(
      { autoCompactAtTokens: 999_999 },
      undefined,
      undefined,
      undefined,
    )
    expect(resolved.autoCompactAtTokens).toBe(AUTO_COMPACT_MAX_TOKENS)
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
