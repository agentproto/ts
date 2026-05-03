import { describe, it, expect } from "vitest"
import { definePolicy } from "../define-policy.js"

describe("definePolicy (AIP-38)", () => {
  // The AIP-38 doctype uses 'id' instead of the cross-AIP
  // default 'id' + 'description'. Constructing a valid def needs every
  // required field — author real tests once build()/validate() are
  // filled in. This file exists so vitest sees ≥1 test in the package.
  it("imports cleanly", () => {
    expect(typeof definePolicy).toBe("function")
  })

  // TODO: spec-38 tests — see @agentproto/operator's test suite as
  // a reference once you wire defaults + cross-field rules.
})
