import { describe, it, expect } from "vitest"
import { defineDesign } from "../define-design.js"
import { parseDesignManifest } from "../manifest/index.js"

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

  it("parses a DESIGN.md carrying the canonical design/v1 tag", () => {
    const md = `---
schema: design/v1
kit: bright
title: Bright
colors: {}
typography: {}
---
`
    expect(parseDesignManifest(md).frontmatter.schema).toBe("design/v1")
  })

  it("still parses the legacy designkit/v1 tag", () => {
    const md = `---
schema: designkit/v1
kit: bright
title: Bright
colors: {}
typography: {}
---
`
    expect(parseDesignManifest(md).frontmatter.schema).toBe("designkit/v1")
  })
})
