import { describe, it, expect } from "vitest"
import { defineAgent } from "../define-agent.js"

describe("defineAgent (AIP-42)", () => {
  // The AIP-42 doctype uses 'id' + 'description' instead of the cross-AIP
  // default 'id' + 'description'. Constructing a valid def needs every
  // required field — author real tests once build()/validate() are
  // filled in. This file exists so vitest sees ≥1 test in the package.
  it("imports cleanly", () => {
    expect(typeof defineAgent).toBe("function")
  })

  // TODO: spec-42 tests — see @agentproto/operator's test suite as
  // a reference once you wire defaults + cross-field rules.
})

describe("defineAgent model requirement", () => {
  const base = { schema: "agent/v1" as const, id: "synthetic", description: "A synthetic agent." }

  it("refuses a missing model with 'model is required'", () => {
    expect(() => defineAgent(base as never)).toThrow("model is required")
  })

  it("refuses a blank model with 'model is required'", () => {
    expect(() => defineAgent({ ...base, model: "  " })).toThrow("model is required")
  })

  it("accepts a model string", () => {
    expect(defineAgent({ ...base, model: "provider/model" }).model).toBe("provider/model")
  })
})
