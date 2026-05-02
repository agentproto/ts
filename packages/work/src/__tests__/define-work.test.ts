import { describe, it, expect } from "vitest"
import { defineWork } from "../define-work.js"

describe("defineWork (AIP-20)", () => {
  // The AIP-20 doctype uses 'name' + 'description' instead of the cross-AIP
  // default 'id' + 'description'. Constructing a valid def needs every
  // required field — author real tests once build()/validate() are
  // filled in. This file exists so vitest sees ≥1 test in the package.
  it("imports cleanly", () => {
    expect(typeof defineWork).toBe("function")
  })

  // TODO: spec-20 tests — see @agentproto/operator's test suite as
  // a reference once you wire defaults + cross-field rules.
})
