import { describe, expect, it } from "vitest"
import { parseKnowledgeManifest } from "../manifest/index.js"

const entry = (extra = "") =>
  `---\nschema: knowledge.entry/v1\nslug: alex-park\nkind: entity\ntitle: Alex\n${extra}---\nbody\n`

describe("parseKnowledgeManifest", () => {
  it("rejects a file with no frontmatter", () => {
    expect(() => parseKnowledgeManifest("# just a body\n")).toThrow(/missing or empty frontmatter/)
  })

  it("rejects an unknown discriminator", () => {
    expect(() =>
      parseKnowledgeManifest("---\nschema: knowledge.nope/v1\nslug: x\n---\n"),
    ).toThrow(/invalid frontmatter/)
  })

  it("rejects an entry missing updated_at", () => {
    expect(() => parseKnowledgeManifest(entry())).toThrow(/updated_at/)
  })

  it("normalises an unquoted (Date) and a quoted timestamp to the same ISO string", () => {
    const bare = parseKnowledgeManifest(entry("updated_at: 2026-04-27T17:00:00Z\n"))
    const quoted = parseKnowledgeManifest(entry('updated_at: "2026-04-27T17:00:00.000Z"\n'))
    expect((bare.frontmatter as { updated_at: string }).updated_at).toBe("2026-04-27T17:00:00.000Z")
    expect((quoted.frontmatter as { updated_at: string }).updated_at).toBe(
      "2026-04-27T17:00:00.000Z",
    )
  })

  it("rejects a non-timestamp updated_at", () => {
    expect(() => parseKnowledgeManifest(entry('updated_at: "yesterday"\n'))).toThrow(/updated_at/)
  })

  it("rejects an unknown key on an entry (strict)", () => {
    expect(() =>
      parseKnowledgeManifest(entry("updated_at: 2026-04-27T17:00:00Z\nbogus: 1\n")),
    ).toThrow(/bogus|unrecognized/i)
  })
})
