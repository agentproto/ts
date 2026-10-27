/**
 * Autocompact, the ABSOLUTE token threshold that compacts an idle
 * session's context (the percent ladder never fires on a 1M-token
 * window) and the short resume prompt that follows it.
 *
 * These tests are the contract:
 *   - the threshold is clamped (never rejected, never above the max)
 *   - autocompact fires only on an idle session above the threshold
 *   - it never fires twice while a compaction is in flight
 *   - the resume prompt is injected only when the session really had work
 *     in progress (a background task, a pending tool call, an unanswered
 *     prompt, or a turn that died), never because it has a title or goal
 *   - the compaction carries the full transcript path and the two lookup
 *     tools, so the session can recover what the summary dropped
 */

import { describe, expect, it, vi } from "vitest"
import {
  AUTO_COMPACT_DEFAULT_TOKENS,
  AUTO_COMPACT_MAX_TOKENS,
  AUTO_COMPACT_MIN_TOKENS,
  buildAutoCompactCompactInstructions,
  buildAutoCompactResumePrompt,
  buildAutoCompactTranscriptNote,
  clampAutoCompactTokens,
  compactCommandTakesInstructions,
  createAutoCompactController,
  decideAutoCompact,
  deriveLastTurnOutcome,
  hasWorkInProgress,
  type AutoCompactControllerDeps,
  type WorkInProgressSnapshot,
} from "../auto-compact.js"
import {
  CONTEXT_CONTINUITY_DEFAULTS,
  computeContextContinuityStatus,
  resolveContextContinuityPolicy,
} from "../context-continuity.js"

describe("clampAutoCompactTokens", () => {
  it("defaults to 150k when unset", () => {
    expect(clampAutoCompactTokens(undefined)).toBe(AUTO_COMPACT_DEFAULT_TOKENS)
    expect(AUTO_COMPACT_DEFAULT_TOKENS).toBe(150_000)
  })

  it("clamps a value above the maximum down to 600k", () => {
    expect(clampAutoCompactTokens(700_000)).toBe(AUTO_COMPACT_MAX_TOKENS)
    expect(AUTO_COMPACT_MAX_TOKENS).toBe(600_000)
    expect(clampAutoCompactTokens(600_001)).toBe(600_000)
  })

  it("accepts a large-window threshold up to the maximum unchanged", () => {
    expect(clampAutoCompactTokens(550_000)).toBe(550_000)
    expect(clampAutoCompactTokens(600_000)).toBe(600_000)
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

/** The state of a session that was simply done: nothing in progress. */
const idleSnapshot: WorkInProgressSnapshot = {
  backgroundTaskOutstanding: false,
  pendingToolCall: false,
  lastTurnOutcome: "completed",
}

/** The state of a session that was cut short mid-work. */
const workingSnapshot: WorkInProgressSnapshot = {
  backgroundTaskOutstanding: false,
  pendingToolCall: false,
  lastTurnOutcome: "error",
}

function deps(overrides: Partial<AutoCompactControllerDeps> = {}): AutoCompactControllerDeps {
  return {
    readTokens: () => 200_000,
    readThreshold: () => 150_000,
    isIdle: () => true,
    hasBackgroundTask: () => false,
    isCompacting: () => false,
    requestCompact: async () => ({ snapshot: idleSnapshot }),
    requestResume: async () => undefined,
    transcriptPath: () => "/tmp/sessions/sess_1/events.jsonl",
    ...overrides,
  }
}

describe("createAutoCompactController", () => {
  it("compacts an idle session above the threshold", async () => {
    const requestCompact = vi.fn(async () => ({ snapshot: idleSnapshot }))
    const controller = createAutoCompactController(deps({ requestCompact }))
    const decision = await controller.maybeTrigger()
    expect(decision.trigger).toBe(true)
    expect(requestCompact).toHaveBeenCalledTimes(1)
  })

  it("does not compact a busy session", async () => {
    const requestCompact = vi.fn(async () => ({ snapshot: idleSnapshot }))
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
      return { snapshot: idleSnapshot }
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

  it("injects the resume prompt when the session had work in progress", async () => {
    const requestResume = vi.fn(async (_prompt: string) => undefined)
    const controller = createAutoCompactController(
      deps({
        requestCompact: async () => ({ snapshot: workingSnapshot, goal: "ship the PR" }),
        requestResume,
      }),
    )
    await controller.maybeTrigger()
    expect(requestResume).toHaveBeenCalledTimes(1)
    const prompt = requestResume.mock.calls[0]![0] as string
    expect(prompt).toContain("ship the PR")
    expect(prompt).toContain("/tmp/sessions/sess_1/events.jsonl")
  })

  it("does not inject a resume prompt when nothing was in progress", async () => {
    const requestResume = vi.fn(async (_prompt: string) => undefined)
    const controller = createAutoCompactController(
      deps({
        requestCompact: async () => ({ snapshot: idleSnapshot }),
        requestResume,
      }),
    )
    await controller.maybeTrigger()
    expect(requestResume).not.toHaveBeenCalled()
  })

  it("does not inject a resume prompt just because the session has a goal", async () => {
    // The goal is TEXT for the resume prompt, never the trigger: a session
    // that merely finished its work must not be woken up.
    const requestResume = vi.fn(async (_prompt: string) => undefined)
    const controller = createAutoCompactController(
      deps({
        requestCompact: async () => ({ snapshot: idleSnapshot, goal: "ship the PR" }),
        requestResume,
      }),
    )
    await controller.maybeTrigger()
    expect(requestResume).not.toHaveBeenCalled()
  })

  it("does not compact again until the context has dropped below the threshold", async () => {
    // A harness that reports an unchanged usage figure after the
    // compaction must not put the session into a compaction loop.
    const requestCompact = vi.fn(async () => ({ snapshot: idleSnapshot }))
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
      return { snapshot: idleSnapshot }
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
      return { snapshot: idleSnapshot }
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
    const requestCompact = vi.fn(async () => ({ snapshot: idleSnapshot }))
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

  it("names the two lookup tools so the session can recover what was dropped", () => {
    const prompt = buildAutoCompactResumePrompt({ transcriptPath: "/tmp/e.jsonl" })
    expect(prompt).toContain("transcript_search")
    expect(prompt).toContain("transcript_read")
  })
})

describe("buildAutoCompactTranscriptNote", () => {
  it("cites the transcript path and the two lookup tools", () => {
    const note = buildAutoCompactTranscriptNote("/tmp/sessions/sess_1/events.jsonl")
    expect(note).toContain("/tmp/sessions/sess_1/events.jsonl")
    expect(note).toContain("transcript_search")
    expect(note).toContain("transcript_read")
    // One line: it rides along with a prompt.
    expect(note).not.toContain("\n")
  })
})

describe("buildAutoCompactCompactInstructions", () => {
  it("asks the summary to keep the transcript path and the lookup tools", () => {
    const instructions = buildAutoCompactCompactInstructions({
      transcriptPath: "/tmp/sessions/sess_1/events.jsonl",
    })
    expect(instructions).toContain("/tmp/sessions/sess_1/events.jsonl")
    expect(instructions).toContain("transcript_search")
    expect(instructions).toContain("transcript_read")
  })
})

describe("compactCommandTakesInstructions", () => {
  it("is true for claude-code, whose /compact takes an argument", () => {
    expect(compactCommandTakesInstructions("claude-code")).toBe(true)
  })

  it("is false for the harnesses that dispatch the compaction by name only", () => {
    for (const harness of ["codex", "opencode", "hermes", "fake", undefined]) {
      expect(compactCommandTakesInstructions(harness)).toBe(false)
    }
  })
})

describe("hasWorkInProgress", () => {
  const idle: WorkInProgressSnapshot = {
    backgroundTaskOutstanding: false,
    pendingToolCall: false,
    lastTurnOutcome: "completed",
  }

  it("is false for a session that was simply done", () => {
    expect(hasWorkInProgress(idle)).toBe(false)
  })

  it("is true while a background task is outstanding", () => {
    expect(hasWorkInProgress({ ...idle, backgroundTaskOutstanding: true })).toBe(true)
  })

  it("is true while a tool call is pending", () => {
    expect(hasWorkInProgress({ ...idle, pendingToolCall: true })).toBe(true)
  })

  it("is true when the last turn ended on an error", () => {
    expect(hasWorkInProgress({ ...idle, lastTurnOutcome: "error" })).toBe(true)
  })

  it("is false when the last turn was cancelled (a user stop must not be resumed)", () => {
    expect(hasWorkInProgress({ ...idle, lastTurnOutcome: "cancelled" })).toBe(false)
  })

  it("is true when the last turn was interrupted", () => {
    expect(hasWorkInProgress({ ...idle, lastTurnOutcome: "interrupted" })).toBe(true)
  })

  it("is false when the last turn's outcome is unknown", () => {
    expect(hasWorkInProgress({ ...idle, lastTurnOutcome: "unknown" })).toBe(false)
  })
})

describe("deriveLastTurnOutcome", () => {
  it("maps the turn-end reasons that mean the work died", () => {
    expect(deriveLastTurnOutcome({ reason: "error" })).toBe("error")
    expect(deriveLastTurnOutcome({ reason: "cancelled" })).toBe("cancelled")
    expect(deriveLastTurnOutcome({ reason: "aborted" })).toBe("interrupted")
    expect(deriveLastTurnOutcome({ reason: "watchdog-timeout" })).toBe("error")
    expect(deriveLastTurnOutcome({ interrupted: true })).toBe("interrupted")
  })

  it("maps a clean turn to completed", () => {
    expect(deriveLastTurnOutcome({ reason: "completed" })).toBe("completed")
  })

  it("reports an adapter-reported error even without a reason", () => {
    expect(deriveLastTurnOutcome({ errored: true })).toBe("error")
  })

  it("reports unknown when there is no marker at all", () => {
    expect(deriveLastTurnOutcome({})).toBe("unknown")
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
})
