import { describe, it, expect } from "vitest"
import { defineStorage } from "../define-storage.js"

describe("defineStorage (AIP-35)", () => {
  // The AIP-35 doctype uses 'id' instead of the cross-AIP
  // default 'id' + 'description'. Constructing a valid def needs every
  // required field — author real tests once build()/validate() are
  // filled in. This file exists so vitest sees ≥1 test in the package.
  it("imports cleanly", () => {
    expect(typeof defineStorage).toBe("function")
  })

  // TODO: spec-35 tests — see @agentproto/operator's test suite as
  // a reference once you wire defaults + cross-field rules.
})
