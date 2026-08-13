import { describe, expect, it } from "vitest"
import { resolvePiContextWindow } from "../client.js"

describe("resolvePiContextWindow", () => {
  it("resolves a cataloged model id (incl. pi's moonshotai/ wire prefix) to its real window", () => {
    // The exact model id from the context-hard-stop repro (sess_e9edfc55):
    // pi's --model wire spelling, aliased in @agentproto/model-catalog to
    // the bare "kimi-k2.5" catalog entry (262144 tokens).
    expect(resolvePiContextWindow("moonshotai/kimi-k2.5")).toBe(262144)
  })

  it("returns undefined for a model the catalog doesn't know — never a fabricated number", () => {
    expect(resolvePiContextWindow("totally-unknown-model-xyz")).toBeUndefined()
  })

  it("returns undefined when no model id is given", () => {
    expect(resolvePiContextWindow(undefined)).toBeUndefined()
  })
})
