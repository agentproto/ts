import { describe, it, expect } from "vitest"
import { defineLesson } from "../define-lesson.js"

describe("defineLesson (AIP-11)", () => {
  // The AIP-11 doctype uses 'slug' + 'title' instead of the cross-AIP
  // default 'id' + 'description'. Constructing a valid def needs every
  // required field — author real tests once build()/validate() are
  // filled in. This file exists so vitest sees ≥1 test in the package.
  it("imports cleanly", () => {
    expect(typeof defineLesson).toBe("function")
  })

  // TODO: spec-11 tests — see @agentproto/operator's test suite as
  // a reference once you wire defaults + cross-field rules.
})
