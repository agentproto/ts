import { readdirSync, readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { knowledgeFromManifest, parseKnowledgeManifest } from "../manifest/index.js"

// Every frontmatter fence in AIP-10's EXAMPLES.md, copied verbatim.
const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures")
const files = readdirSync(FIXTURES)
  .filter((f) => f.endsWith(".md"))
  .sort()

// Examples the spec's own JSON Schema rejects (spec bug, not a code bug).
// Pinned so the mismatch stays visible; drop the entry once the spec is
// amended. Value = the error the schema is expected to raise.
const SPEC_MISMATCHES: Record<string, RegExp> = {
  // tags[2] = `fork:ops`, but `tags[]` items must match ^[a-z][a-z0-9-]*$
  "example-06.entry.md": /tags\.2: .*must match pattern/,
}

describe("AIP-10 spec examples", () => {
  it("has all 12 example fixtures (entry, source, workspace branches)", () => {
    expect(files).toHaveLength(12)
    for (const branch of ["entry", "source", "workspace"]) {
      expect(files.some((f) => f.includes(`.${branch}.`))).toBe(true)
    }
  })

  describe.each(files)("%s", (file) => {
    const src = readFileSync(path.join(FIXTURES, file), "utf8")

    if (file in SPEC_MISMATCHES) {
      it("is rejected only for the known spec/schema mismatch", () => {
        expect(() => parseKnowledgeManifest(src)).toThrow(SPEC_MISMATCHES[file]!)
        const patched = src.replace("fork:ops", "fork-ops")
        expect(patched).not.toBe(src)
        expect(() => knowledgeFromManifest(parseKnowledgeManifest(patched))).not.toThrow()
      })
      return
    }

    it("parses through parseKnowledgeManifest", () => {
      const { frontmatter } = parseKnowledgeManifest(src)
      expect(frontmatter.schema).toMatch(/^knowledge\.(entry|source|workspace)\/v1$/)
    })

    it("builds a frozen handle through knowledgeFromManifest", () => {
      const handle = knowledgeFromManifest(parseKnowledgeManifest(src))
      expect(Object.isFrozen(handle)).toBe(true)
    })
  })
})
