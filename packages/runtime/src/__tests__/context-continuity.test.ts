import { describe, it, expect } from "vitest"
import {
  CONTEXT_CONTINUITY_DEFAULTS,
  COLD_WAKE_GUARD_DEFAULTS,
  IDLE_COMPACT_DEFAULT_CACHE_TTL_MS,
  IDLE_COMPACT_DEFAULTS,
  computeCacheWarmUntil,
  computeContextContinuityStatus,
  computeContextPct,
  contextContinuityNextAction,
  contextContinuityStateForPct,
  effectiveColdWakeGuard,
  effectiveIdleCompact,
  isColdCache,
  isContextContinuityHardStopped,
  planIdleCompactArm,
  promptCacheTtlMsFromMetadata,
  resolveContextContinuityPolicy,
  shouldColdWakeGuard,
  validateContextContinuityColdWakeGuard,
  validateContextContinuityIdleCompact,
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

  it("merges compactHandoffTurn, defaulting to undefined (off) at every layer", () => {
    expect(
      resolveContextContinuityPolicy(undefined, undefined, undefined, undefined).compactHandoffTurn
    ).toBeUndefined()
    expect(
      resolveContextContinuityPolicy(undefined, { compactHandoffTurn: true }, undefined, undefined)
        .compactHandoffTurn
    ).toBe(true)
    // A higher layer's explicit false overrides a lower layer's true.
    expect(
      resolveContextContinuityPolicy(
        { compactHandoffTurn: true },
        undefined,
        undefined,
        { compactHandoffTurn: false },
      ).compactHandoffTurn
    ).toBe(false)
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

  it("projects cache-warmth stamps when supplied", () => {
    const status = computeContextContinuityStatus("sess_1", policy, 1000, 550, {
      lastTurnEndAt: "2026-01-01T00:00:00.000Z",
      cacheWarmUntil: "2026-01-01T00:05:00.000Z",
    })
    expect(status.lastTurnEndAt).toBe("2026-01-01T00:00:00.000Z")
    expect(status.cacheWarmUntil).toBe("2026-01-01T00:05:00.000Z")
  })

  it("omits cache-warmth stamps when absent (legacy sessions stay byte-identical)", () => {
    const status = computeContextContinuityStatus("sess_1", policy, 1000, 550)
    expect(status).not.toHaveProperty("lastTurnEndAt")
    expect(status).not.toHaveProperty("cacheWarmUntil")
  })
})

// ── AIP-46 amendment: idleCompact + coldWakeGuard ──────────────────────────

describe("validateContextContinuityIdleCompact", () => {
  it("accepts the built-in defaults", () => {
    expect(validateContextContinuityIdleCompact(IDLE_COMPACT_DEFAULTS).ok).toBe(true)
  })

  it("accepts a fully-specified valid block", () => {
    const result = validateContextContinuityIdleCompact({
      mode: "auto",
      atPct: 50,
      beforeCacheExpiryMs: 60_000,
      action: "continue-fresh",
    })
    expect(result.ok).toBe(true)
  })

  it("rejects an unknown mode", () => {
    const result = validateContextContinuityIdleCompact({ mode: "yes" as never })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain("idleCompact.mode")
  })

  it("rejects atPct outside 0-100 or non-integer", () => {
    expect(validateContextContinuityIdleCompact({ atPct: -1 }).ok).toBe(false)
    expect(validateContextContinuityIdleCompact({ atPct: 101 }).ok).toBe(false)
    expect(validateContextContinuityIdleCompact({ atPct: 50.5 }).ok).toBe(false)
  })

  it("rejects a negative beforeCacheExpiryMs", () => {
    const result = validateContextContinuityIdleCompact({ beforeCacheExpiryMs: -1 })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain("beforeCacheExpiryMs")
  })

  it("rejects an unknown action", () => {
    const result = validateContextContinuityIdleCompact({ action: "compact-now" as never })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain("idleCompact.action")
  })
})

describe("validateContextContinuityColdWakeGuard", () => {
  it("accepts the built-in defaults", () => {
    expect(validateContextContinuityColdWakeGuard(COLD_WAKE_GUARD_DEFAULTS).ok).toBe(true)
  })

  it("rejects an unknown mode", () => {
    const result = validateContextContinuityColdWakeGuard({ mode: "on" as never })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain("coldWakeGuard.mode")
  })

  it("rejects atPct outside 0-100", () => {
    expect(validateContextContinuityColdWakeGuard({ atPct: -1 }).ok).toBe(false)
    expect(validateContextContinuityColdWakeGuard({ atPct: 101 }).ok).toBe(false)
  })
})

describe("resolveContextContinuityPolicy idleCompact/coldWakeGuard precedence", () => {
  it("absent blocks at every level leave the policy without them (off by default)", () => {
    const resolved = resolveContextContinuityPolicy(undefined, undefined, undefined, undefined)
    expect(resolved.idleCompact).toBeUndefined()
    expect(resolved.coldWakeGuard).toBeUndefined()
    expect(effectiveIdleCompact(resolved).mode).toBe("off")
    expect(effectiveColdWakeGuard(resolved).mode).toBe("off")
  })

  it("session block wins WHOLE — absent session fields do not inherit from config", () => {
    const resolved = resolveContextContinuityPolicy(
      { idleCompact: { mode: "auto", atPct: 40, beforeCacheExpiryMs: 90_000, action: "continue-fresh" } },
      undefined,
      undefined,
      { idleCompact: { mode: "ask" } },
    )
    expect(resolved.idleCompact).toEqual({
      mode: "ask",
      atPct: IDLE_COMPACT_DEFAULTS.atPct,
      beforeCacheExpiryMs: IDLE_COMPACT_DEFAULTS.beforeCacheExpiryMs,
      action: IDLE_COMPACT_DEFAULTS.action,
    })
  })

  it("a level with no block inherits the lower level's block untouched", () => {
    const resolved = resolveContextContinuityPolicy(
      { coldWakeGuard: { mode: "auto", atPct: 75 } },
      undefined,
      undefined,
      undefined,
    )
    expect(resolved.coldWakeGuard).toEqual({ mode: "auto", atPct: 75 })
  })

  it("coldWakeGuard block follows the same whole-object rule", () => {
    const resolved = resolveContextContinuityPolicy(
      { coldWakeGuard: { mode: "auto", atPct: 60 } },
      undefined,
      undefined,
      { coldWakeGuard: { atPct: 80 } },
    )
    expect(resolved.coldWakeGuard).toEqual({ mode: COLD_WAKE_GUARD_DEFAULTS.mode, atPct: 80 })
  })

  it("effective* defaults when the block was never configured", () => {
    const resolved = resolveContextContinuityPolicy(undefined, undefined, undefined, undefined)
    expect(effectiveIdleCompact(resolved)).toEqual(IDLE_COMPACT_DEFAULTS)
    expect(effectiveColdWakeGuard(resolved)).toEqual(COLD_WAKE_GUARD_DEFAULTS)
  })

  it("rejects an invalid idleCompact block merged into the policy", () => {
    expect(() =>
      resolveContextContinuityPolicy(undefined, undefined, undefined, {
        idleCompact: { mode: "yes" as never },
      }),
    ).toThrow(/idleCompact/)
  })
})

describe("planIdleCompactArm", () => {
  const ON = { ...IDLE_COMPACT_DEFAULTS, mode: "auto" as const }
  const nowMs = Date.UTC(2026, 0, 1, 12, 0, 0)
  const warmMs = nowMs + 5 * 60_000 // 5-minute cache TTL window

  it("arms: fires at cacheWarmUntil − beforeCacheExpiryMs, above atPct, warm cache", () => {
    const plan = planIdleCompactArm({
      idleCompact: ON,
      contextPct: 60,
      nowMs,
      cacheWarmUntilMs: warmMs,
    })
    expect(plan).toEqual({
      firesAtMs: warmMs - ON.beforeCacheExpiryMs,
      cacheWarmUntilMs: warmMs,
    })
  })

  it("clamps a fire instant already in the past to nowMs (cache still warm)", () => {
    const plan = planIdleCompactArm({
      idleCompact: { ...ON, beforeCacheExpiryMs: 10 * 60_000 },
      contextPct: 60,
      nowMs,
      cacheWarmUntilMs: warmMs, // 5 min out — but beforeCacheExpiryMs is 10 min
    })
    expect(plan).toEqual({ firesAtMs: nowMs, cacheWarmUntilMs: warmMs })
  })

  it("mode off never arms", () => {
    expect(
      planIdleCompactArm({
        idleCompact: IDLE_COMPACT_DEFAULTS,
        contextPct: 90,
        nowMs,
        cacheWarmUntilMs: warmMs,
      }),
    ).toBeNull()
  })

  it("context unknown (null) never arms", () => {
    expect(
      planIdleCompactArm({ idleCompact: ON, contextPct: null, nowMs, cacheWarmUntilMs: warmMs }),
    ).toBeNull()
  })

  it("context at/below atPct never arms", () => {
    expect(
      planIdleCompactArm({ idleCompact: ON, contextPct: ON.atPct, nowMs, cacheWarmUntilMs: warmMs }),
    ).toBeNull()
  })

  it("no cache warmth (absent or expired) never arms", () => {
    expect(planIdleCompactArm({ idleCompact: ON, contextPct: 60, nowMs })).toBeNull()
    expect(planIdleCompactArm({ idleCompact: ON, contextPct: 60, nowMs, cacheWarmUntilMs: nowMs })).toBeNull()
    expect(
      planIdleCompactArm({ idleCompact: ON, contextPct: 60, nowMs, cacheWarmUntilMs: nowMs - 1 }),
    ).toBeNull()
  })

  it("a known next wake BEFORE cacheWarmUntil suppresses arming (step 5)", () => {
    expect(
      planIdleCompactArm({
        idleCompact: ON,
        contextPct: 60,
        nowMs,
        cacheWarmUntilMs: warmMs,
        nextWakeAtMs: nowMs + 60_000,
      }),
    ).toBeNull()
  })

  it("a next wake AT/AFTER cacheWarmUntil does not suppress arming", () => {
    const plan = planIdleCompactArm({
      idleCompact: ON,
      contextPct: 60,
      nowMs,
      cacheWarmUntilMs: warmMs,
      nextWakeAtMs: warmMs,
    })
    expect(plan?.firesAtMs).toBe(warmMs - ON.beforeCacheExpiryMs)
  })
})

describe("isColdCache", () => {
  const nowMs = 1_000_000

  it("absent warmth is cold", () => {
    expect(isColdCache(undefined, nowMs)).toBe(true)
    expect(isColdCache(null, nowMs)).toBe(true)
  })

  it("non-finite warmth is cold", () => {
    expect(isColdCache(Number.NaN, nowMs)).toBe(true)
    expect(isColdCache(Number.POSITIVE_INFINITY, nowMs)).toBe(true)
  })

  it("warmth at/past now is cold", () => {
    expect(isColdCache(nowMs, nowMs)).toBe(true)
    expect(isColdCache(nowMs - 1, nowMs)).toBe(true)
  })

  it("warmth strictly in the future is warm", () => {
    expect(isColdCache(nowMs + 1, nowMs)).toBe(false)
  })
})

describe("shouldColdWakeGuard", () => {
  const GUARD = { mode: "auto" as const, atPct: 75 }
  const nowMs = 1_000_000

  it("fires: mode on, above atPct, cache cold", () => {
    expect(shouldColdWakeGuard({ coldWakeGuard: GUARD, contextPct: 80, nowMs })).toBe(true)
  })

  it("mode off never fires", () => {
    expect(
      shouldColdWakeGuard({
        coldWakeGuard: { ...GUARD, mode: "off" as const },
        contextPct: 90,
        nowMs,
      }),
    ).toBe(false)
  })

  it("context unknown (null) never fires", () => {
    expect(shouldColdWakeGuard({ coldWakeGuard: GUARD, contextPct: null, nowMs })).toBe(false)
  })

  it("context at/below atPct never fires", () => {
    expect(shouldColdWakeGuard({ coldWakeGuard: GUARD, contextPct: 75, nowMs })).toBe(false)
  })

  it("a warm cache never fires (whatever the percentage)", () => {
    expect(
      shouldColdWakeGuard({
        coldWakeGuard: GUARD,
        contextPct: 90,
        nowMs,
        cacheWarmUntilMs: nowMs + 60_000,
      }),
    ).toBe(false)
  })
})

describe("computeCacheWarmUntil / promptCacheTtlMsFromMetadata", () => {
  it("computeCacheWarmUntil adds the TTL to the turn-end instant", () => {
    const endMs = 1_000_000
    expect(computeCacheWarmUntil(endMs)).toBe(endMs + IDLE_COMPACT_DEFAULT_CACHE_TTL_MS)
    expect(computeCacheWarmUntil(endMs, 120_000)).toBe(endMs + 120_000)
  })

  it("promptCacheTtlMsFromMetadata reads metadata.promptCacheTtlMs", () => {
    expect(promptCacheTtlMsFromMetadata({ promptCacheTtlMs: 600_000 })).toBe(600_000)
  })

  it("promptCacheTtlMsFromMetadata falls back to the 5-minute floor", () => {
    expect(promptCacheTtlMsFromMetadata(undefined)).toBe(IDLE_COMPACT_DEFAULT_CACHE_TTL_MS)
    expect(promptCacheTtlMsFromMetadata(null)).toBe(IDLE_COMPACT_DEFAULT_CACHE_TTL_MS)
    expect(promptCacheTtlMsFromMetadata("nope")).toBe(IDLE_COMPACT_DEFAULT_CACHE_TTL_MS)
    expect(promptCacheTtlMsFromMetadata({})).toBe(IDLE_COMPACT_DEFAULT_CACHE_TTL_MS)
    expect(promptCacheTtlMsFromMetadata({ promptCacheTtlMs: -5 })).toBe(IDLE_COMPACT_DEFAULT_CACHE_TTL_MS)
    expect(promptCacheTtlMsFromMetadata({ promptCacheTtlMs: 0 })).toBe(IDLE_COMPACT_DEFAULT_CACHE_TTL_MS)
    expect(promptCacheTtlMsFromMetadata({ promptCacheTtlMs: Number.NaN })).toBe(
      IDLE_COMPACT_DEFAULT_CACHE_TTL_MS,
    )
  })
})
