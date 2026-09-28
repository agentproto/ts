import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, it, expect } from "vitest"
import { parseCollectionManifest, collectionFromManifest } from "../manifest/index.js"

/**
 * Fixtures in `./fixtures/*.md` are verbatim copies of the fenced ```md
 * blocks in `specs/resources/aip-18/draft/EXAMPLES.md` (examples 1–7,
 * extracted mechanically by line range — see the PR that added this file
 * for the extraction script). If AIP-18's examples change, re-extract
 * rather than hand-edit these fixtures out of sync with the spec.
 */
const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures")

const SCHEMA_FIXTURES = [
  "example-1-tasks.schema.md",
  "example-2-bugs.schema.md",
  "example-3-okrs.schema.md",
  "example-4-eng-bug.schema.md",
  "example-5-incidents.schema.md",
  "example-7-eng-team-bug.schema.md",
]

const ITEM_FIXTURES = ["example-6-bug.item.md", "example-6-okr.item.md"]

function loadFixture(name: string): string {
  return readFileSync(join(FIXTURES_DIR, name), "utf8")
}

describe("AIP-18 spec examples (EXAMPLES.md) — collection.schema/v1", () => {
  for (const name of SCHEMA_FIXTURES) {
    it(`parses ${name}`, () => {
      const manifest = parseCollectionManifest(loadFixture(name))
      expect(manifest.frontmatter.schema).toBe("collection.schema/v1")
      const handle = collectionFromManifest(manifest)
      expect(Object.isFrozen(handle)).toBe(true)
    })
  }

  it("example-3 (okrs) round-trips a recursive array field (keyResults: array<string>)", () => {
    const { frontmatter } = parseCollectionManifest(loadFixture("example-3-okrs.schema.md"))
    if (frontmatter.schema !== "collection.schema/v1") throw new Error("unreachable")
    const keyResults = frontmatter.fields?.find((f) => f.name === "keyResults")
    expect(keyResults).toMatchObject({ type: "array", items: { type: "string" } })
  })

  it("example-5 (incidents) round-trips a recursive array field (impactWindow: array<datetime>)", () => {
    const { frontmatter } = parseCollectionManifest(loadFixture("example-5-incidents.schema.md"))
    if (frontmatter.schema !== "collection.schema/v1") throw new Error("unreachable")
    const impactWindow = frontmatter.fields?.find((f) => f.name === "impactWindow")
    expect(impactWindow).toMatchObject({ type: "array", items: { type: "datetime" } })
  })

  it("example-4 (eng-bug) narrows the severity enum and sets extends", () => {
    const { frontmatter } = parseCollectionManifest(loadFixture("example-4-eng-bug.schema.md"))
    if (frontmatter.schema !== "collection.schema/v1") throw new Error("unreachable")
    expect(frontmatter.extends).toBe("../bugs/COLLECTION.md")
    const severity = frontmatter.fields?.find((f) => f.name === "severity")
    expect(severity?.enum).toEqual(["medium", "high", "critical"])
  })

  it("example-7 (eng-team-bug) is a bound view — appliesTo + extends both set", () => {
    const { frontmatter } = parseCollectionManifest(
      loadFixture("example-7-eng-team-bug.schema.md"),
    )
    if (frontmatter.schema !== "collection.schema/v1") throw new Error("unreachable")
    expect(frontmatter.extends).toBe("../bugs/COLLECTION.md")
    expect(frontmatter.appliesTo).toEqual(["ws://workspaces/eng-tracker"])
  })
})

describe("AIP-18 spec examples (EXAMPLES.md) — collection.item/v1", () => {
  for (const name of ITEM_FIXTURES) {
    it(`parses ${name}`, () => {
      const manifest = parseCollectionManifest(loadFixture(name))
      expect(manifest.frontmatter.schema).toBe("collection.item/v1")
      const handle = collectionFromManifest(manifest)
      expect(Object.isFrozen(handle)).toBe(true)
    })
  }

  it("example-6 bug item carries collection-specific fields via additionalProperties", () => {
    const { frontmatter } = parseCollectionManifest(loadFixture("example-6-bug.item.md"))
    if (frontmatter.schema !== "collection.item/v1") throw new Error("unreachable")
    expect(frontmatter.collection).toBe("bugs")
    expect(frontmatter.id).toBe("BUG-1042")
    // `severity` / `repro` / `affectedVersion` are collection-specific fields,
    // not part of AIP-18's universal item core — only visible because the
    // item branch is additionalProperties: true.
    expect((frontmatter as Record<string, unknown>).severity).toBe("high")
    expect((frontmatter as Record<string, unknown>).repro).toContain("Safari 17.4")
  })

  it("example-6 OKR item carries a multi-owner array (coLeads)", () => {
    const { frontmatter } = parseCollectionManifest(loadFixture("example-6-okr.item.md"))
    if (frontmatter.schema !== "collection.item/v1") throw new Error("unreachable")
    expect((frontmatter as Record<string, unknown>).coLeads).toEqual([
      "ws://operators/cfo-assistant",
      "ws://operators/coo-assistant",
    ])
  })
})
