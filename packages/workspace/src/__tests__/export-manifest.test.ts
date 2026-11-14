import { describe, it, expect } from "vitest"
import { parseExportManifest, writeExportManifest } from "../export-manifest.js"

describe("EXPORT.md round-trip", () => {
  it("writes and parses back the same digest, body untouched", () => {
    const md = writeExportManifest(
      { schema: "workspace-export/v1", from: "@jeremy/perso", generated_at: "2026-10-17T07:00:00Z", generated_by: "coach" },
      "## Santé\n\nRien à signaler.\n",
    )
    expect(md).toContain("schema: workspace.export/v1")
    const parsed = parseExportManifest(md)
    expect(parsed.frontmatter.from).toBe("@jeremy/perso")
    expect(parsed.frontmatter.generated_by).toBe("coach")
    expect(parsed.frontmatter.sections).toEqual([])
    expect(parsed.body.trim()).toBe("## Santé\n\nRien à signaler.".trim())
  })

  it("never validates the body — arbitrary prose round-trips byte for byte", () => {
    // Deliberately NOT a line starting with `---`: that's gray-matter's own
    // frontmatter delimiter, a pre-existing limitation of every AIP
    // markdown+frontmatter doctype (v1 WORKSPACE.md included), not something
    // EXPORT.md's lack of body validation is responsible for.
    const body = "anything at all: numbers 123, punctuation !?#, no schema touches this.\n"
    const md = writeExportManifest({ schema: "workspace-export/v1", from: "@a/b", generated_at: "2026-10-17T07:00:00Z" }, body)
    const parsed = parseExportManifest(md)
    expect(parsed.body.trim()).toBe(body.trim())
  })

  it("rejects a from-id that isn't scoped", () => {
    expect(() =>
      writeExportManifest({ schema: "workspace-export/v1", from: "perso", generated_at: "2026-10-17T07:00:00Z" }, ""),
    ).toThrow()
  })

  it("parses the canonical workspace.export/v1 tag", () => {
    const md = "---\nschema: workspace.export/v1\nfrom: \"@a/b\"\ngenerated_at: \"2026-10-17T07:00:00Z\"\n---\n"
    expect(parseExportManifest(md).frontmatter.schema).toBe("workspace.export/v1")
  })

  it("still parses the legacy workspace-export/v1 tag", () => {
    const md = "---\nschema: workspace-export/v1\nfrom: \"@a/b\"\ngenerated_at: \"2026-10-17T07:00:00Z\"\n---\n"
    expect(parseExportManifest(md).frontmatter.schema).toBe("workspace-export/v1")
  })

  it("writes the canonical tag even when handed the legacy one", () => {
    const md = writeExportManifest({ schema: "workspace-export/v1", from: "@a/b", generated_at: "2026-10-17T07:00:00Z" }, "")
    expect(md).toContain("schema: workspace.export/v1")
  })

  it("parseExportManifest rejects a wrong schema literal", () => {
    const md = "---\nschema: workspace-export/v2\nfrom: \"@a/b\"\ngenerated_at: \"2026-10-17T07:00:00Z\"\n---\n"
    expect(() => parseExportManifest(md)).toThrow(/parseExportManifest/)
  })
})
