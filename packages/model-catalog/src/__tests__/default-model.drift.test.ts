/**
 * DRIFT CHECK (intentionally data-dependent): the default Anthropic model
 * must still be served by the synced tables. Run separately by the Catalog
 * Sync workflow, which reports a failure in the sync PR description rather
 * than aborting the run.
 */
import { describe, it, expect } from "vitest"
import { isKnownLlmId, resolveContextWindow } from "../llm/catalog.js"
import { DEFAULT_ANTHROPIC_MODEL } from "../llm/defaults.js"

describe("default model ↔ synced tables drift", () => {
  it("DEFAULT_ANTHROPIC_MODEL is a known id with a context window", () => {
    expect(isKnownLlmId(DEFAULT_ANTHROPIC_MODEL)).toBe(true)
    expect(resolveContextWindow(DEFAULT_ANTHROPIC_MODEL)).toBeDefined()
  })
})
