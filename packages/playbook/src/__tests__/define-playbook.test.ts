import { describe, it, expect } from "vitest"
import { definePlaybook } from "../define-playbook.js"

describe("definePlaybook (AIP-12)", () => {
  // The AIP-12 doctype uses 'slug' + 'title' instead of the cross-AIP
  // default 'id' + 'description'. Constructing a valid def needs every
  // required field — author real tests once build()/validate() are
  // filled in. This file exists so vitest sees ≥1 test in the package.
  it("imports cleanly", () => {
    expect(typeof definePlaybook).toBe("function")
  })

  // TODO: spec-12 tests — see @agentproto/operator's test suite as
  // a reference once you wire defaults + cross-field rules.
})
