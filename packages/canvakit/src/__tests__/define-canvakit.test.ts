import { describe, it, expect } from "vitest"
import { defineCanvakit } from "../define-canvakit.js"

describe("defineCanvakit (AIP-5)", () => {
  // The AIP-5 doctype uses 'name' instead of the cross-AIP
  // default 'id' + 'description'. Constructing a valid def needs every
  // required field — author real tests once build()/validate() are
  // filled in. This file exists so vitest sees ≥1 test in the package.
  it("imports cleanly", () => {
    expect(typeof defineCanvakit).toBe("function")
  })

  // TODO: spec-5 tests — see @agentproto/operator's test suite as
  // a reference once you wire defaults + cross-field rules.
})
