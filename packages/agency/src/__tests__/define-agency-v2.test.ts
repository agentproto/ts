import { describe, it, expect } from "vitest"
import { defineAgencyV2 } from "../define-agency-v2.js"

describe("defineAgencyV2 (AIP-21)", () => {
  // The AIP-21 doctype uses 'name' + 'description' instead of the cross-AIP
  // default 'id' + 'description'. Constructing a valid def needs every
  // required field — author real tests once build()/validate() are
  // filled in. This file exists so vitest sees ≥1 test in the package.
  it("imports cleanly", () => {
    expect(typeof defineAgencyV2).toBe("function")
  })

  // TODO: spec-21 tests — see @agentproto/operator's test suite as
  // a reference once you wire defaults + cross-field rules.
})
