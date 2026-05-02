import { describe, it, expect } from "vitest"
import { defineExtension } from "../define-extension.js"

describe("defineExtension (AIP-40)", () => {
  // The AIP-40 doctype uses 'slug' + 'description' instead of the cross-AIP
  // default 'id' + 'description'. Constructing a valid def needs every
  // required field — author real tests once build()/validate() are
  // filled in. This file exists so vitest sees ≥1 test in the package.
  it("imports cleanly", () => {
    expect(typeof defineExtension).toBe("function")
  })

  // TODO: spec-40 tests — see @agentproto/operator's test suite as
  // a reference once you wire defaults + cross-field rules.
})
