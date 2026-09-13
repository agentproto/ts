import { describe, it, expect } from "vitest"
import {
  CONTEXT_CONTINUITY_DEFAULTS,
  computeContextContinuityStatus,
  computeContextPct,
  contextContinuityNextAction,
  contextContinuityStateForPct,
  isContextContinuityHardStopped,
  resolveContextContinuityPolicy,
  validateContextContinuityPolicy,
  type ContextContinuityPolicy,
} from "../context-continuity.js"

describe("validateContextContinuityPolicy", () => {
  it("accepts the built-in defaults", () => {
    const result = validateContextContinuityPolicy(CONTEXT_CONTINUITY_DEFAULTS)
    expect(result.ok).toBe(true)
  })

  it("accepts a fully-specified valid policy", () => {
    const result = validateContextContinuityPolicy({
      mode: "auto",
      warnAtPct: 50,
      compactAtPct: 60,
      continueFreshAtPct: 70,
      hardStopAtPct: 80,
    })
    expect(result.ok).toBe(true)
  })

  it("rejects warnAtPct >= compactAtPct", () => {
    const result = validateContextContinuityPolicy({ warnAtPct: 65, compactAtPct: 65 })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain("warnAtPct")
  })

  it("rejects compactAtPct >= continueFreshAtPct", () => {
    const result = validateContextContinuityPolicy({ compactAtPct: 75, continueFreshAtPct: 75 })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain("compactAtPct")
  })

  it("rejects continueFreshAtPct >= hardStopAtPct", () => {
    const result = validateContextContinuityPolicy({ continueFreshAtPct: 90, hardStopAtPct: 90 })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain("continueFreshAtPct")
  })

  it("rejects percentages outside 0-100", () => {
    expect(validateContextContinuityPolicy({ warnAtPct: -1 }).ok).toBe(false)
    expect(validateContextContinuityPolicy({ warnAtPct: 101 }).ok).toBe(false)
    expect(validateContextContinuityPolicy({ warnAtPct: 55.5 }).ok).toBe(false)
  })
})

describe("resolveContextContinuityPolicy", () => {
  it("fills safe defaults when nothing is supplied", () => {
    const resolved = resolveContextContinuityPolicy(undefined, undefined, undefined, undefined)
    expect(resolved).toEqual(CONTEXT_CONTINUITY_DEFAULTS)
  })

  it("merges global → harness → session override", () => {
    const global: ContextContinuityPolicy = { mode: "manual", warnAtPct: 50 }
    const harness: ContextContinuityPolicy = { compactAtPct: 60 }
    const session: ContextContinuityPolicy = { hardStopAtPct: 85 }
    const resolved = resolveContextContinuityPolicy(global, harness, undefined, session)
    expect(resolved.mode).toBe("manual")
    expect(resolved.warnAtPct).toBe(50)
    expect(resolved.compactAtPct).toBe(60)
    expect(resolved.continueFreshAtPct).toBe(CONTEXT_CONTINUITY_DEFAULTS.continueFreshAtPct)
    expect(resolved.hardStopAtPct).toBe(85)
  })

  it("session override wins over all lower layers", () => {
    const resolved = resolveContextContinuityPolicy(
      { mode: "manual" },
      { mode: "ask" },
      { mode: "auto" },
      { mode: "manual" },
    )
    expect(resolved.mode).toBe("manual")
  })

  it("throws on invalid combined policy", () => {
    expect(() =>
      resolveContextContinuityPolicy(undefined, undefined, undefined, { warnAtPct: 90 })
    ).toThrow(/Invalid context continuity policy/)
  })
})

describe("computeContextPct", () => {
  it("returns null when size is unknown", () => {
    expect(computeContextPct(undefined, 100)).toBeNull()
  })

  it("returns null when used is unknown", () => {
    expect(computeContextPct(1000, undefined)).toBeNull()
  })

  it("computes the percentage and rounds", () => {
    expect(computeContextPct(1000, 550)).toBe(55)
    expect(computeContextPct(1000, 555)).toBe(56)
  })

  // Regression: an adapter with no real context-window figure (e.g. pi's
  // historical bug, adapters/pi/src/pi-events.ts) can report the exact same
  // number for both fields. That's indistinguishable from "unknown" — never
  // a real 100% — so the rail must not act on it (sess_e9edfc55: this
  // pinned contextPct at 100% and hard-stopped a healthy session on turn 1).
  it("returns null when contextSize === contextUsed (degenerate, indistinguishable from unknown)", () => {
    expect(computeContextPct(9009, 9009)).toBeNull()
    expect(computeContextPct(1, 1)).toBeNull()
  })

  it("still computes a real percentage when used is merely close to, but not equal to, size", () => {
    expect(computeContextPct(9009, 9008)).toBe(100)
  })
})

describe("contextContinuityStateForPct", () => {
  const thresholds = {
    warnAtPct: 55,
    compactAtPct: 65,
    continueFreshAtPct: 75,
    hardStopAtPct: 90,
  }

  it("returns ok below warn", () => expect(contextContinuityStateForPct(54, thresholds)).toBe("ok"))
  it("returns warn at warn threshold", () => expect(contextContinuityStateForPct(55, thresholds)).toBe("warn"))
  it("returns compact at compact threshold", () =>
    expect(contextContinuityStateForPct(65, thresholds)).toBe("compact"))
  it("returns continue-fresh at continue threshold", () =>
    expect(contextContinuityStateForPct(75, thresholds)).toBe("continue-fresh"))
  it("returns hard-stop at hard-stop threshold", () =>
    expect(contextContinuityStateForPct(90, thresholds)).toBe("hard-stop"))
})

describe("contextContinuityNextAction", () => {
  it("manual mode only acts on hard-stop", () => {
    expect(contextContinuityNextAction("ok", "manual")).toBe("none")
    expect(contextContinuityNextAction("warn", "manual")).toBe("none")
    expect(contextContinuityNextAction("compact", "manual")).toBe("none")
    expect(contextContinuityNextAction("continue-fresh", "manual")).toBe("none")
    expect(contextContinuityNextAction("hard-stop", "manual")).toBe("hard-stop")
  })

  it("ask mode surfaces warnings and asks at action thresholds", () => {
    expect(contextContinuityNextAction("ok", "ask")).toBe("none")
    expect(contextContinuityNextAction("warn", "ask")).toBe("warn")
    expect(contextContinuityNextAction("compact", "ask")).toBe("ask")
    expect(contextContinuityNextAction("continue-fresh", "ask")).toBe("ask")
    expect(contextContinuityNextAction("hard-stop", "ask")).toBe("hard-stop")
  })

  it("auto mode compacts and continues fresh", () => {
    expect(contextContinuityNextAction("ok", "auto")).toBe("none")
    expect(contextContinuityNextAction("warn", "auto")).toBe("warn")
    expect(contextContinuityNextAction("compact", "auto")).toBe("compact")
    expect(contextContinuityNextAction("continue-fresh", "auto")).toBe("continue-fresh")
    expect(contextContinuityNextAction("hard-stop", "auto")).toBe("hard-stop")
  })
})

describe("computeContextContinuityStatus", () => {
  const policy = CONTEXT_CONTINUITY_DEFAULTS

  it("reports unknown when no context telemetry exists", () => {
    const status = computeContextContinuityStatus("sess_1", policy, undefined, undefined)
    expect(status.contextPct).toBeNull()
    expect(status.state).toBe("ok")
    expect(status.nextThresholdDelta).toBeNull()
  })

  it("reports warn at 55%", () => {
    const status = computeContextContinuityStatus("sess_1", policy, 1000, 550)
    expect(status.contextPct).toBe(55)
    expect(status.state).toBe("warn")
    expect(status.nextAction).toBe("warn")
    expect(status.nextThresholdDelta).toBe(10)
  })

  it("reports compact at 65%", () => {
    const status = computeContextContinuityStatus("sess_1", policy, 1000, 650)
    expect(status.state).toBe("compact")
    expect(status.nextAction).toBe("ask")
  })

  it("reports continue-fresh at 75%", () => {
    const status = computeContextContinuityStatus("sess_1", policy, 1000, 750)
    expect(status.state).toBe("continue-fresh")
    expect(status.nextAction).toBe("ask")
  })

  it("reports hard-stop at 90%", () => {
    const status = computeContextContinuityStatus("sess_1", policy, 1000, 900)
    expect(status.state).toBe("hard-stop")
    expect(status.nextAction).toBe("hard-stop")
    expect(status.nextThresholdDelta).toBeNull()
  })

  // Regression for sess_e9edfc55 (pi adapter, moonshotai/kimi-k2.5): the
  // adapter's contextSize/contextUsed were both 9009 (its per-turn token
  // total, echoed into both fields for lack of a real window figure). The
  // rail must treat that as unknown and take no action — not hard-stop a
  // session on its very first turn.
  it("takes no rail action when contextSize === contextUsed (the pi turn-1 bug)", () => {
    const status = computeContextContinuityStatus("sess_e9edfc55", policy, 9009, 9009)
    expect(status.contextPct).toBeNull()
    expect(status.state).toBe("ok")
    expect(status.nextAction).toBe("none")
    expect(isContextContinuityHardStopped(status.contextPct, policy)).toBe(false)
  })

  it("takes no rail action when contextSize is entirely absent", () => {
    const status = computeContextContinuityStatus("sess_1", policy, undefined, 500)
    expect(status.nextAction).toBe("none")
    expect(isContextContinuityHardStopped(status.contextPct, policy)).toBe(false)
  })
})
