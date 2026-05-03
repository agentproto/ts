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
