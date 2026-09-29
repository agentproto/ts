import { describe, it, expect } from "vitest"
import { parseToolManifest } from "../manifest/index.js"
import { checkMinimalJsonSchema } from "../json-schema.js"

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

describe("parseToolManifest: AIP-16 IO block well-formedness", () => {
  const manifestWith = (io: string) => `---
name: Echo
id: echo
description: Returns its input verbatim.
version: 0.1.0
${io}
---
`

  it("accepts well-formed inputs/outputs blocks", () => {
    const m = parseToolManifest(
      manifestWith(`inputs:
  type: object
  properties:
    msg:
      type: string
  required: [msg]
outputs:
  type: object
  properties:
    echo:
      $ref: "#/properties/msg"
      enum: [a, b]
`),
    )
    expect(m.frontmatter.inputs).toBeDefined()
    expect(m.frontmatter.outputs).toBeDefined()
  })

  it("accepts blocks that omit the checked keys", () => {
    const m = parseToolManifest(manifestWith("inputs:\n  type: string\n"))
    expect(m.frontmatter.inputs).toEqual({ type: "string" })
  })

  it("rejects properties that is not an object", () => {
    expect(() =>
      parseToolManifest(manifestWith('inputs:\n  properties: "..."')),
    ).toThrow(/invalid inputs block for tool echo: properties must be an object/)
  })

  it("rejects required that is not an array of strings", () => {
    expect(() =>
      parseToolManifest(manifestWith('inputs:\n  required: "name"')),
    ).toThrow(/invalid inputs block for tool echo: required must be an array of strings/)
  })

  it("rejects required entries that are not strings", () => {
    expect(() =>
      parseToolManifest(manifestWith("inputs:\n  required:\n  - 42")),
    ).toThrow(/required must be an array of strings/)
  })

  it("rejects type that is neither string nor string array", () => {
    expect(() =>
      parseToolManifest(manifestWith("inputs:\n  type: 42")),
    ).toThrow(/invalid inputs block for tool echo: type must be a string or array of strings/)
  })

  it("rejects an empty type array", () => {
    expect(() =>
      parseToolManifest(manifestWith("inputs:\n  type: []")),
    ).toThrow(/type must be a string or array of strings/)
  })

  it("rejects a non-string $ref", () => {
    expect(() =>
      parseToolManifest(manifestWith("outputs:\n  $ref: 7")),
    ).toThrow(/invalid outputs block for tool echo: \$ref must be a string/)
  })

  it("rejects an empty enum", () => {
    expect(() =>
      parseToolManifest(manifestWith("inputs:\n  enum: []")),
    ).toThrow(/invalid inputs block for tool echo: enum must be a non-empty array/)
  })

  it("rejects items that is not an object", () => {
    expect(() =>
      parseToolManifest(manifestWith("inputs:\n  items: \"nope\"")),
    ).toThrow(/invalid inputs block for tool echo: items must be an object or array of objects/)
  })

  it("accepts tuple-form items (array of objects)", () => {
    const m = parseToolManifest(
      manifestWith("inputs:\n  items:\n    - type: string\n"),
    )
    expect(m.frontmatter.inputs).toEqual({ items: [{ type: "string" }] })
  })

  it("rejects a block that is not an object at all", () => {
    // Non-object blocks are caught earlier by the frontmatter zod schema
    // (z.record); checkMinimalJsonSchema defends the same invariant for
    // direct callers.
    expect(checkMinimalJsonSchema(42)).toEqual([
      { path: "", message: "schema must be an object" },
    ])
  })

  it("accepts tuple-form type arrays", () => {
    const m = parseToolManifest(manifestWith("inputs:\n  type: [string, 'null']\n"))
    expect(m.frontmatter.inputs).toEqual({ type: ["string", "null"] })
  })
})
