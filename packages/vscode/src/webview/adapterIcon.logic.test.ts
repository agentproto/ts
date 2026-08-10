import { describe, expect, it } from "vitest"

import { adapterLogoFor } from "./adapterIcon.logic.js"

describe("adapterLogoFor", () => {
  it("maps known harness/provider slugs to the canonical icon files", () => {
    expect(adapterLogoFor("claude-code")).toEqual({ kind: "icon", file: "claude.svg" })
    expect(adapterLogoFor("claude-sdk")).toEqual({ kind: "icon", file: "anthropic.svg" })
    expect(adapterLogoFor("anthropic")).toEqual({ kind: "icon", file: "anthropic.svg" })
    expect(adapterLogoFor("codex")).toEqual({ kind: "icon", file: "openai.svg" })
    expect(adapterLogoFor("openai")).toEqual({ kind: "icon", file: "openai.svg" })
    expect(adapterLogoFor("hermes")).toEqual({ kind: "icon", file: "hermes.svg" })
    expect(adapterLogoFor("opencode")).toEqual({ kind: "icon", file: "opencode.svg" })
    expect(adapterLogoFor("mastracode")).toEqual({ kind: "icon", file: "mastra.svg" })
    expect(adapterLogoFor("mastracode-inprocess")).toEqual({ kind: "icon", file: "mastra.svg" })
    expect(adapterLogoFor("mastra-agent")).toEqual({ kind: "icon", file: "mastra.svg" })
    expect(adapterLogoFor("openclaw")).toEqual({ kind: "icon", file: "openclaw.png" })
    expect(adapterLogoFor("browser")).toEqual({ kind: "icon", file: "browser.svg" })
  })

  it("maps newly added brand icons", () => {
    expect(adapterLogoFor("deepseek")).toEqual({ kind: "icon", file: "deepseek.svg" })
    expect(adapterLogoFor("gemini")).toEqual({ kind: "icon", file: "gemini.svg" })
    expect(adapterLogoFor("gemini-cli")).toEqual({ kind: "icon", file: "gemini.svg" })
    expect(adapterLogoFor("mistral-vibe")).toEqual({ kind: "icon", file: "mistral.svg" })
    expect(adapterLogoFor("openrouter")).toEqual({ kind: "icon", file: "openrouter.svg" })
    expect(adapterLogoFor("qwen-code")).toEqual({ kind: "icon", file: "qwen.svg" })
  })

  it("falls back to a lettermark for unknown slugs", () => {
    expect(adapterLogoFor("pi")).toEqual({ kind: "lettermark", text: "π" })
    expect(adapterLogoFor("moonshot")).toEqual({ kind: "lettermark", text: "K" })
    expect(adapterLogoFor("xai")).toEqual({ kind: "lettermark", text: "X" })
    expect(adapterLogoFor("requesty")).toEqual({ kind: "lettermark", text: "R" })
  })

  it("is case-insensitive and trims whitespace", () => {
    expect(adapterLogoFor("Claude-Code ")).toEqual({ kind: "icon", file: "claude.svg" })
    expect(adapterLogoFor("  OPENROUTER ")).toEqual({ kind: "icon", file: "openrouter.svg" })
  })
})
