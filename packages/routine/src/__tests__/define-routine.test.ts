import { describe, it, expect } from "vitest"
import { defineRoutine } from "../define-routine.js"

describe("defineRoutine (AIP-41)", () => {
  // The AIP-41 doctype uses 'id' + 'description' instead of the cross-AIP
  // default 'id' + 'description'. Constructing a valid def needs every
  // required field — author real tests once build()/validate() are
  // filled in. This file exists so vitest sees ≥1 test in the package.
  it("imports cleanly", () => {
    expect(typeof defineRoutine).toBe("function")
  })

  // TODO: spec-41 tests — see @agentproto/operator's test suite as
  // a reference once you wire defaults + cross-field rules.
})
