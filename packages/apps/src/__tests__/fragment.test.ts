import { describe, it, expect } from "vitest"
import {
  parseConfigFragment,
  buildConfigFragment,
  shouldApplyIncomingView,
  CONFIG_SECTIONS,
} from "../config/fragment.js"

describe("config app deep-link fragment", () => {
  it("parses a bare section", () => {
    expect(parseConfigFragment("#wallets")).toEqual({ section: "wallets" })
  })

  it("parses section/id", () => {
    expect(parseConfigFragment("#wallets/claude-subs-agentik")).toEqual({
      section: "wallets",
      id: "claude-subs-agentik",
    })
  })

  it("parses section/id/sub", () => {
    expect(parseConfigFragment("#remote/pairing/ab12cd34")).toEqual({
      section: "remote",
      id: "pairing",
      sub: "ab12cd34",
    })
  })

  it("decodes a percent-encoded id", () => {
    expect(parseConfigFragment("#models/anthropic%2Fclaude-opus-5-5")).toEqual({
      section: "models",
      id: "anthropic/claude-opus-5-5",
    })
  })

  it("falls back to the first section on an unknown section", () => {
    expect(parseConfigFragment("#bogus/whatever")).toEqual({
      section: CONFIG_SECTIONS[0],
      id: "whatever",
    })
  })

  it("falls back to the first section on an empty/missing hash", () => {
    expect(parseConfigFragment("")).toEqual({ section: CONFIG_SECTIONS[0] })
    expect(parseConfigFragment("#")).toEqual({ section: CONFIG_SECTIONS[0] })
  })

  it("keeps the raw segment when percent-decoding throws", () => {
    expect(parseConfigFragment("#defaults/%E0%A4%A")).toEqual({
      section: "defaults",
      id: "%E0%A4%A",
    })
  })

  it("round-trips through buildConfigFragment", () => {
    const hash = buildConfigFragment("models", "anthropic/claude-opus-5-5")
    expect(hash).toBe("#models/anthropic%2Fclaude-opus-5-5")
    expect(parseConfigFragment(hash)).toEqual({
      section: "models",
      id: "anthropic/claude-opus-5-5",
    })
  })

  it("builds section-only and section/id/sub fragments", () => {
    expect(buildConfigFragment("wallets")).toBe("#wallets")
    expect(buildConfigFragment("remote", "pairing", "ab12cd34")).toBe("#remote/pairing/ab12cd34")
  })

  it("parses a raw view the same with or without a leading '#'", () => {
    // ui.ts's routeToView feeds an MCP-hosted `view` argument straight through
    // parseConfigFragment — this is the "accept with or without a leading #"
    // contract PR-5 adds, and it falls out of parseConfigFragment's existing
    // `replace(/^#/, "")` with no extra code.
    expect(parseConfigFragment("wallets/my-profile")).toEqual(parseConfigFragment("#wallets/my-profile"))
    expect(buildConfigFragment("harnesses")).toBe("#harnesses")
    expect(parseConfigFragment("harnesses")).toEqual(parseConfigFragment(buildConfigFragment("harnesses")))
  })
})

describe("shouldApplyIncomingView", () => {
  it("ignores the first arrival when the browser already had a non-empty hash at load", () => {
    expect(shouldApplyIncomingView(1, true)).toBe(false)
  })

  it("applies the first arrival when there was no browser hash at load", () => {
    expect(shouldApplyIncomingView(1, false)).toBe(true)
  })

  it("always applies every arrival after the first, hash or no hash", () => {
    expect(shouldApplyIncomingView(2, true)).toBe(true)
    expect(shouldApplyIncomingView(3, true)).toBe(true)
    expect(shouldApplyIncomingView(2, false)).toBe(true)
  })
})
