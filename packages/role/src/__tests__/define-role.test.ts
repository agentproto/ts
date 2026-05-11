import { describe, it, expect } from "vitest"
import { defineRole } from "../define-role.js"

describe("defineRole (AIP-47)", () => {
  // The AIP-47 doctype uses 'name' + 'description' instead of the cross-AIP
  // default 'id' + 'description'. Constructing a valid def needs every
  // required field — author real tests once build()/validate() are
  // filled in. This file exists so vitest sees ≥1 test in the package.
  it("imports cleanly", () => {
    expect(typeof defineRole).toBe("function")
  })

  // TODO: spec-47 tests — see @agentproto/operator's test suite as
  // a reference once you wire defaults + cross-field rules.
})
