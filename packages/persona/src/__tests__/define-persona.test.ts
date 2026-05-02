import { describe, it, expect } from "vitest"
import { definePersona } from "../define-persona.js"

describe("definePersona (AIP-25)", () => {
  // The AIP-25 doctype uses 'name' + 'description' instead of the cross-AIP
  // default 'id' + 'description'. Constructing a valid def needs every
  // required field — author real tests once build()/validate() are
  // filled in. This file exists so vitest sees ≥1 test in the package.
  it("imports cleanly", () => {
    expect(typeof definePersona).toBe("function")
  })

  // TODO: spec-25 tests — see @agentproto/operator's test suite as
  // a reference once you wire defaults + cross-field rules.
})
