import { describe, it, expect } from "vitest"
import { defineCompany } from "../define-company.js"
import { parseCompanyManifest } from "../manifest/index.js"

describe("defineCompany (AIP-6)", () => {
  // The AIP-6 doctype uses 'id' instead of the cross-AIP
  // default 'id' + 'description'. Constructing a valid def needs every
  // required field — author real tests once build()/validate() are
  // filled in. This file exists so vitest sees ≥1 test in the package.
  it("imports cleanly", () => {
    expect(typeof defineCompany).toBe("function")
  })

  // TODO: spec-6 tests — see @agentproto/operator's test suite as
  // a reference once you wire defaults + cross-field rules.

  const doc = (tag: string) => `---
schema: ${tag}
doctype: company
id: acme
name: Acme
mission: Ship things.
---
`

  it("parses a COMPANY.md carrying the canonical company/v1 tag", () => {
    expect(parseCompanyManifest(doc("company/v1")).frontmatter.schema).toBe("company/v1")
  })

  it("still parses the legacy agentcompanies/v1 tag", () => {
    expect(parseCompanyManifest(doc("agentcompanies/v1")).frontmatter.schema).toBe("agentcompanies/v1")
  })
})
