import { describe, it, expect } from "vitest"
import { defineIdentity } from "../define-identity.js"

describe("defineIdentity (AIP-23)", () => {
  // The AIP-23 doctype uses 'name' + 'description' instead of the cross-AIP
  // default 'id' + 'description'. Constructing a valid def needs every
  // required field — author real tests once build()/validate() are
  // filled in. This file exists so vitest sees ≥1 test in the package.
  it("imports cleanly", () => {
    expect(typeof defineIdentity).toBe("function")
  })

  // TODO: spec-23 tests — see @agentproto/operator's test suite as
  // a reference once you wire defaults + cross-field rules.
})
