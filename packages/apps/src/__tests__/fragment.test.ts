import { describe, it, expect } from "vitest"
import { parseConfigFragment, buildConfigFragment, CONFIG_SECTIONS } from "../config/fragment.js"

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
})
