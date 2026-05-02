import { describe, it, expect } from "vitest"
import { defineDesign } from "../define-design.js"

describe("defineDesign (AIP-4)", () => {
  // The AIP-4 doctype uses 'id' + 'title' instead of the cross-AIP
  // default 'id' + 'description'. Constructing a valid def needs every
  // required field — author real tests once build()/validate() are
  // filled in. This file exists so vitest sees ≥1 test in the package.
  it("imports cleanly", () => {
    expect(typeof defineDesign).toBe("function")
  })

  // TODO: spec-4 tests — see @agentproto/operator's test suite as
  // a reference once you wire defaults + cross-field rules.
})
