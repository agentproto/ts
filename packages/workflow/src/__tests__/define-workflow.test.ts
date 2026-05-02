import { describe, it, expect } from "vitest"
import { defineWorkflow } from "../define-workflow.js"

describe("defineWorkflow (AIP-15)", () => {
  // The AIP-15 doctype uses 'id' + 'description' instead of the cross-AIP
  // default 'id' + 'description'. Constructing a valid def needs every
  // required field — author real tests once build()/validate() are
  // filled in. This file exists so vitest sees ≥1 test in the package.
  it("imports cleanly", () => {
    expect(typeof defineWorkflow).toBe("function")
  })

  // TODO: spec-15 tests — see @agentproto/operator's test suite as
  // a reference once you wire defaults + cross-field rules.
})
