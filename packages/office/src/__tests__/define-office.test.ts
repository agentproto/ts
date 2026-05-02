import { describe, it, expect } from "vitest"
import { defineOffice } from "../define-office.js"

describe("defineOffice (AIP-22)", () => {
  // The AIP-22 doctype uses 'name' + 'description' instead of the cross-AIP
  // default 'id' + 'description'. Constructing a valid def needs every
  // required field — author real tests once build()/validate() are
  // filled in. This file exists so vitest sees ≥1 test in the package.
  it("imports cleanly", () => {
    expect(typeof defineOffice).toBe("function")
  })

  // TODO: spec-22 tests — see @agentproto/operator's test suite as
  // a reference once you wire defaults + cross-field rules.
})
