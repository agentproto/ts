import { describe, it, expect } from "vitest"
import { defineCollection } from "../define-collection.js"

describe("defineCollection (AIP-18)", () => {
  // The AIP-18 doctype uses 'id' + 'description' instead of the cross-AIP
  // default 'id' + 'description'. Constructing a valid def needs every
  // required field — author real tests once build()/validate() are
  // filled in. This file exists so vitest sees ≥1 test in the package.
  it("imports cleanly", () => {
    expect(typeof defineCollection).toBe("function")
  })

  // TODO: spec-18 tests — see @agentproto/operator's test suite as
  // a reference once you wire defaults + cross-field rules.
})
