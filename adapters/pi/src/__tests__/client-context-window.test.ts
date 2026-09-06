import { describe, expect, it } from "vitest"
import { resolveContextWindow, listNativeModelIds } from "@agentproto/model-catalog/llm"
import { resolvePiContextWindow } from "../client.js"

describe("resolvePiContextWindow", () => {
  it("resolves a cataloged model id (incl. pi's moonshotai/ wire prefix) to its real window", () => {
    // Regression for sess_e9edfc55: pi's --model wire spelling
    // (moonshotai/<id>) must resolve through @agentproto/model-catalog's
    // alias table to a real context window, not silently return undefined.
    // What's under test is that MECHANISM, not any specific model's
    // survival — an earlier version of this test hardcoded
    // "moonshotai/kimi-k2.5", which broke the moment Moonshot retired that
    // id from its live /v1/models sync (catalog-sync PR #1082), the same
    // way a hardcoded entry count broke on every routine sync (#1092).
    // Derive the fixture from the live snapshot instead: pick whichever
    // currently-live moonshot id has a wire-prefix alias, so this can't go
    // stale the same way again.
    const liveMoonshotIds = listNativeModelIds("moonshot")
    expect(liveMoonshotIds.length).toBeGreaterThan(0)
    const resolvable = liveMoonshotIds
      .map(id => ({ id, window: resolvePiContextWindow(`moonshotai/${id}`) }))
      .find(r => r.window !== undefined)
    expect(resolvable).toBeDefined()
    expect(resolvable!.window).toBe(resolveContextWindow(resolvable!.id)!.contextWindow)
  })

  it("returns undefined for a model the catalog doesn't know — never a fabricated number", () => {
    expect(resolvePiContextWindow("totally-unknown-model-xyz")).toBeUndefined()
  })

  it("returns undefined when no model id is given", () => {
    expect(resolvePiContextWindow(undefined)).toBeUndefined()
  })
})
