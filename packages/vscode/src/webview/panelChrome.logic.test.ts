import { describe, expect, it } from "vitest"

import { accessIdentity, contextGauge, harnessGlyph } from "./panelChrome.logic.js"

describe("harnessGlyph", () => {
  it("maps known harness families to distinct marks", () => {
    expect(harnessGlyph("claude-code").glyph).toBe("❋")
    expect(harnessGlyph("codex").glyph).toBe("⬡")
    expect(harnessGlyph("openai-responses").glyph).toBe("⬡")
    expect(harnessGlyph("hermes").glyph).toBe("☿")
    expect(harnessGlyph("gemini-cli").glyph).toBe("♊")
  })

  it("matches on a substring of a lowercased slug so variants resolve", () => {
    expect(harnessGlyph("Claude-Code-Gateway").glyph).toBe("❋")
  })

  it("carries the raw slug as the tooltip label", () => {
    expect(harnessGlyph("claude-code").label).toBe("claude-code")
  })

  it("falls back to a generic mark for an unknown or absent slug", () => {
    expect(harnessGlyph("some-new-harness").glyph).toBe("◆")
    expect(harnessGlyph(undefined)).toEqual({ glyph: "◆", label: "harness" })
    expect(harnessGlyph("")).toEqual({ glyph: "◆", label: "harness" })
  })
})

describe("accessIdentity", () => {
  it("prefers the named profile's label", () => {
    expect(
      accessIdentity({
        accessProfile: { profileRef: "work", label: "Work wallet", vendor: "anthropic", method: "oauth-bearer" },
      }),
    ).toBe("Work wallet")
  })

  it("falls back to the profileRef when the profile has no label", () => {
    expect(
      accessIdentity({
        accessProfile: { profileRef: "personal", vendor: "anthropic", method: "api-key" },
      }),
    ).toBe("personal")
  })

  it("falls back to the raw auth method when no named profile is echoed", () => {
    expect(accessIdentity({ auth: { mode: "subscription", fingerprint: "abc" } })).toBe("subscription")
  })

  it("returns an em dash when neither profile nor auth is present", () => {
    expect(accessIdentity({})).toBe("—")
    expect(accessIdentity(undefined)).toBe("—")
  })
})

describe("contextGauge", () => {
  it("returns ratio, rounded pct, and a color level", () => {
    expect(contextGauge(200_000, 1_000_000)).toEqual({ ratio: 0.2, pct: 20, level: "low" })
  })

  it("buckets the color level at 70% and 90%", () => {
    expect(contextGauge(69, 100)!.level).toBe("low")
    expect(contextGauge(70, 100)!.level).toBe("mid")
    expect(contextGauge(89, 100)!.level).toBe("mid")
    expect(contextGauge(90, 100)!.level).toBe("high")
  })

  it("clamps a runaway used>size to a full ring, not overflow", () => {
    expect(contextGauge(1500, 1000)).toEqual({ ratio: 1, pct: 100, level: "high" })
  })

  it("returns null when size is missing, zero, or non-numeric", () => {
    expect(contextGauge(100, 0)).toBeNull()
    expect(contextGauge(100, undefined)).toBeNull()
    expect(contextGauge(undefined, 1000)).toBeNull()
  })
})
