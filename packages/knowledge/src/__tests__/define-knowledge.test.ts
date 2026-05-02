import { describe, it, expect } from "vitest"
import { defineKnowledge } from "../define-knowledge.js"

describe("defineKnowledge (AIP-10)", () => {
  // The AIP-10 doctype uses 'id' + 'description' instead of the cross-AIP
  // default 'id' + 'description'. Constructing a valid def needs every
  // required field — author real tests once build()/validate() are
  // filled in. This file exists so vitest sees ≥1 test in the package.
  it("imports cleanly", () => {
    expect(typeof defineKnowledge).toBe("function")
  })

  // TODO: spec-10 tests — see @agentproto/operator's test suite as
  // a reference once you wire defaults + cross-field rules.
})
