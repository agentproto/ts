import { describe, expect, it } from "vitest"
import { resolvePiContextWindow } from "../client.js"

describe("resolvePiContextWindow", () => {
  it("resolves a cataloged model id (incl. pi's moonshotai/ wire prefix) to its real window", () => {
    // The original repro (sess_e9edfc55) used moonshotai/kimi-k2.5 — pi's
    // --model wire spelling, aliased in @agentproto/model-catalog to the
    // bare catalog entry. kimi-k2.5 has since aged out of Moonshot's live
    // /v1/models sync (see catalog-sync PR #1082), so this now pins
    // kimi-k2.6 instead — same wire-prefix alias mechanism under test, a
    // model id that's still live, same 262144-token window.
    expect(resolvePiContextWindow("moonshotai/kimi-k2.6")).toBe(262144)
  })

  it("returns undefined for a model the catalog doesn't know — never a fabricated number", () => {
    expect(resolvePiContextWindow("totally-unknown-model-xyz")).toBeUndefined()
  })

  it("returns undefined when no model id is given", () => {
    expect(resolvePiContextWindow(undefined)).toBeUndefined()
  })
})
