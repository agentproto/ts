/**
 * Unit tests for the shared duration parser (`parseDuration`/`formatDuration`)
 * behind every CLI timeout/interval flag. See ../duration.ts for the incident
 * and the design decisions (bare = ms, sub-1000 units-slip guard, msOnly).
 */
import { describe, it, expect } from "vitest"
import { parseDuration, formatDuration } from "../duration.js"

describe("parseDuration — accepted forms", () => {
  it("bare integer >= 1000 is milliseconds, unchanged contract", () => {
    expect(parseDuration("3000", "--timeout")).toEqual({ ok: true, ms: 3000 })
  })

  it("explicit ms suffix", () => {
    expect(parseDuration("500ms", "--timeout")).toEqual({ ok: true, ms: 500 })
  })

  it("explicit s suffix", () => {
    expect(parseDuration("30s", "--timeout")).toEqual({ ok: true, ms: 30_000 })
  })

  it("explicit m suffix", () => {
    expect(parseDuration("5m", "--timeout")).toEqual({ ok: true, ms: 300_000 })
  })

  it("explicit h suffix", () => {
    expect(parseDuration("2h", "--timeout")).toEqual({ ok: true, ms: 7_200_000 })
  })

  it("sub-1000 is fine when the unit is explicit", () => {
    expect(parseDuration("5ms", "--timeout")).toEqual({ ok: true, ms: 5 })
    expect(parseDuration("1s", "--timeout")).toEqual({ ok: true, ms: 1000 })
  })

  it("exactly 1000 bare is accepted (the guard is strictly < 1000)", () => {
    expect(parseDuration("1000", "--timeout")).toEqual({ ok: true, ms: 1000 })
  })
})

describe("parseDuration — the units-slip guard (bare < 1000)", () => {
  it("rejects a bare number under 1000 with an actionable, dual-reading message", () => {
    const result = parseDuration("30", "--timeout")
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("unreachable")
    expect(result.error).toContain("--timeout 30")
    expect(result.error).toContain("30ms is almost certainly not what you meant")
    expect(result.error).toContain("30s")
    expect(result.error).toContain("30ms")
  })

  it("rejects bare 999 but accepts bare 1000", () => {
    expect(parseDuration("999", "--timeout").ok).toBe(false)
    expect(parseDuration("1000", "--timeout").ok).toBe(true)
  })
})

describe("parseDuration — rejection cases", () => {
  it("rejects empty string", () => {
    const result = parseDuration("", "--timeout")
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("unreachable")
    expect(result.error).toContain("--timeout is empty")
  })

  it("rejects whitespace-only string", () => {
    expect(parseDuration("   ", "--timeout").ok).toBe(false)
  })

  it("rejects NaN / non-numeric input", () => {
    expect(parseDuration("NaN", "--timeout").ok).toBe(false)
    expect(parseDuration("abc", "--timeout").ok).toBe(false)
  })

  it("rejects negative numbers", () => {
    expect(parseDuration("-5", "--timeout").ok).toBe(false)
    expect(parseDuration("-5s", "--timeout").ok).toBe(false)
  })

  it("rejects an unknown suffix", () => {
    const result = parseDuration("30x", "--timeout")
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("unreachable")
    expect(result.error).toContain('invalid --timeout "30x"')
  })

  it("rejects float/decimal input", () => {
    expect(parseDuration("1.5s", "--timeout").ok).toBe(false)
    expect(parseDuration("3.5", "--timeout").ok).toBe(false)
  })

  it("rejects 0 in any unit, with a message explaining why", () => {
    for (const raw of ["0", "0ms", "0s", "0m", "0h"]) {
      const result = parseDuration(raw, "--timeout")
      expect(result.ok).toBe(false)
      if (result.ok) throw new Error("unreachable")
      expect(result.error).toContain("0 is never a real wait")
    }
  })
})

describe("parseDuration — msOnly (--timeout-ms and friends)", () => {
  it("bare number is ms, no sub-1000 guard since the name already disambiguates", () => {
    expect(parseDuration("30", "--timeout-ms", { msOnly: true })).toEqual({ ok: true, ms: 30 })
    expect(parseDuration("5", "--timeout-ms", { msOnly: true })).toEqual({ ok: true, ms: 5 })
  })

  it("an explicit ms suffix is accepted", () => {
    expect(parseDuration("30ms", "--timeout-ms", { msOnly: true })).toEqual({ ok: true, ms: 30 })
  })

  it("rejects a non-ms suffix instead of silently misparsing it", () => {
    const result = parseDuration("30s", "--timeout-ms", { msOnly: true })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("unreachable")
    expect(result.error).toContain("already declares milliseconds")
  })

  it("still rejects 0", () => {
    expect(parseDuration("0", "--timeout-ms", { msOnly: true }).ok).toBe(false)
  })

  it("still rejects garbage", () => {
    expect(parseDuration("abc", "--timeout-ms", { msOnly: true }).ok).toBe(false)
  })
})

describe("formatDuration", () => {
  it("renders sub-second as ms", () => {
    expect(formatDuration(500)).toBe("500ms")
    expect(formatDuration(0)).toBe("0ms")
  })

  it("renders seconds", () => {
    expect(formatDuration(3000)).toBe("3s")
    expect(formatDuration(1000)).toBe("1s")
  })

  it("renders minutes", () => {
    expect(formatDuration(300_000)).toBe("5m")
  })

  it("renders hours", () => {
    expect(formatDuration(7_200_000)).toBe("2h")
  })

  it("renders days", () => {
    expect(formatDuration(2 * 86_400_000)).toBe("2d")
  })
})
