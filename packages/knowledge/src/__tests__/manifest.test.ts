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

  it("accepts a 1000-char entry title and rejects 1001", () => {
    const ts = "updated_at: 2026-04-27T17:00:00Z\n"
    const withTitle = (t: string) => entry(ts).replace("title: Alex", `title: ${t}`)
    expect(
      (parseKnowledgeManifest(withTitle("x".repeat(1000))).frontmatter as { title: string }).title,
    ).toHaveLength(1000)
    expect(() => parseKnowledgeManifest(withTitle("x".repeat(1001)))).toThrow(/title/)
  })

  it("rejects an unknown key on an entry (strict)", () => {
    expect(() =>
      parseKnowledgeManifest(entry("updated_at: 2026-04-27T17:00:00Z\nbogus: 1\n")),
    ).toThrow(/bogus|unrecognized/i)
  })
})
