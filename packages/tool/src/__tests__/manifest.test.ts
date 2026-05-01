import { describe, it, expect } from "vitest"
import { parseToolManifest } from "../manifest/index.js"

describe("parseToolManifest", () => {
  it("parses a minimal valid manifest", () => {
    const source = `---
schema: agentproto/tool/v1
name: Echo
id: echo
description: Returns its input verbatim.
version: 0.1.0
---

# Echo
Body content.
`
    const m = parseToolManifest(source)
    expect(m.frontmatter.id).toBe("echo")
    expect(m.frontmatter.name).toBe("Echo")
    expect(m.frontmatter.version).toBe("0.1.0")
    expect(m.body).toContain("# Echo")
  })

  it("parses optional fields when present", () => {
    const source = `---
name: Pricing
id: pricing-snapshot
description: Snapshots prices.
version: 1.0.0
mutates: [database:prices]
approval: on-mutate
risk_level: 2
cost_class: metered
timeout_ms: 60000
idempotent: false
tags: [finance, read-from-airtable]
---
`
    const m = parseToolManifest(source)
    expect(m.frontmatter.mutates).toEqual(["database:prices"])
    expect(m.frontmatter.approval).toBe("on-mutate")
    expect(m.frontmatter.risk_level).toBe(2)
    expect(m.frontmatter.cost_class).toBe("metered")
    expect(m.frontmatter.timeout_ms).toBe(60_000)
    expect(m.frontmatter.tags).toEqual(["finance", "read-from-airtable"])
  })

  it("rejects missing frontmatter", () => {
    expect(() => parseToolManifest("just a body, no frontmatter")).toThrow(
      /missing or empty frontmatter/
    )
  })

  it("rejects invalid id", () => {
    const source = `---
name: Bad
id: NOT-LOWERCASE
description: x
version: 0.1.0
---
`
    expect(() => parseToolManifest(source)).toThrow(/id/)
  })

  it("rejects missing required fields", () => {
    const source = `---
name: Missing
id: missing
---
`
    expect(() => parseToolManifest(source)).toThrow(/description|version/)
  })
})
