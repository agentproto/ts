import { describe, it, expect } from "vitest"
import { defineCode } from "../define-code.js"

describe("defineCode (AIP-26)", () => {
  // The AIP-26 doctype uses 'id' + 'description' instead of the cross-AIP
  // default 'id' + 'description'. Constructing a valid def needs every
  // required field — author real tests once build()/validate() are
  // filled in. This file exists so vitest sees ≥1 test in the package.
  it("imports cleanly", () => {
    expect(typeof defineCode).toBe("function")
  })

  // TODO: spec-26 tests — see @agentproto/operator's test suite as
  // a reference once you wire defaults + cross-field rules.
})
