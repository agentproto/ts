import { describe, it, expect } from "vitest"
import { parseCollectionManifest } from "../manifest/index.js"

describe("parseCollectionManifest — invalid docs", () => {
  it("rejects a doc with no frontmatter", () => {
    expect(() => parseCollectionManifest("# Just a heading\n\nNo frontmatter here.")).toThrow(
      /missing or empty frontmatter/,
    )
  })

  it("rejects frontmatter matching neither branch of the schema/item union", () => {
    const src = `---
schema: something.else/v1
foo: bar
---
body
`
    expect(() => parseCollectionManifest(src)).toThrow(/invalid frontmatter/)
  })

  it("rejects a collection.schema/v1 doc missing required fields", () => {
    const src = `---
schema: collection.schema/v1
name: tasks
---
body
`
    expect(() => parseCollectionManifest(src)).toThrow(/invalid frontmatter/)
  })

  it("rejects a collection.item/v1 doc whose `collection` ref matches neither oneOf branch", () => {
    const src = `---
schema: collection.item/v1
collection: 123
id: TASK-1
title: Bad ref
---
body
`
    expect(() => parseCollectionManifest(src)).toThrow(/invalid frontmatter/)
  })

  it("rejects a collection.item/v1 doc whose object-form collection ref is missing `name`", () => {
    const src = `---
schema: collection.item/v1
collection:
  version: "1.x"
id: TASK-1
title: Bad ref
---
body
`
    expect(() => parseCollectionManifest(src)).toThrow(/invalid frontmatter/)
  })

  it("accepts a minimal valid collection.item/v1 doc and preserves the markdown body", () => {
    const src = `---
schema: collection.item/v1
collection: tasks
id: TASK-1
title: Ship the release notes
---
# Ship the release notes

Body prose.
`
    const { frontmatter, body } = parseCollectionManifest(src)
    expect(frontmatter).toMatchObject({ schema: "collection.item/v1", id: "TASK-1" })
    expect(body.trim()).toBe("# Ship the release notes\n\nBody prose.".trim())
  })
})
