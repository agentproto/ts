import { describe, it, expect } from "vitest"
import { parseTypesManifest, writeTypesManifest, resolveTypeEntry } from "../types-registry.js"

describe("TYPES.md round-trip", () => {
  it("writes and parses back the same registry", () => {
    const md = writeTypesManifest({
      schema: "workspace-types/v1",
      types: {
        root: { parents: [], max_per_tree: 1 },
        project: { parents: ["root"], default_wall: "isolated", requires_files: ["RAPPORT.md"] },
      },
    })
    expect(md).toContain("schema: workspace-types/v1")
    const parsed = parseTypesManifest(md)
    expect(parsed.types.project?.requires_files).toEqual(["RAPPORT.md"])
    expect(parsed.types.root?.max_per_tree).toBe(1)
  })

  it("applies the requires_files default ([]) when omitted", () => {
    const md = writeTypesManifest({
      schema: "workspace-types/v1",
      types: { root: { parents: [] } },
    })
    const parsed = parseTypesManifest(md)
    expect(parsed.types.root?.requires_files).toEqual([])
  })

  it("parses the canonical workspace.types/v1 tag", () => {
    const md = "---\nschema: workspace.types/v1\ntypes:\n  root:\n    parents: []\n---\n"
    expect(parseTypesManifest(md).schema).toBe("workspace.types/v1")
  })

  it("still parses the legacy workspace-types/v1 tag", () => {
    const md = "---\nschema: workspace-types/v1\ntypes:\n  root:\n    parents: []\n---\n"
    expect(parseTypesManifest(md).schema).toBe("workspace-types/v1")
  })

  it("keeps writing the legacy tag even when handed the canonical one", () => {
    const md = writeTypesManifest({ schema: "workspace.types/v1", types: { root: { parents: [] } } })
    expect(md).toContain("schema: workspace-types/v1")
  })

  it("rejects an invalid type key", () => {
    expect(() =>
      writeTypesManifest({ schema: "workspace-types/v1", types: { "Not_Valid": { parents: [] } } }),
    ).toThrow()
  })
})

describe("resolveTypeEntry — extends-chain merge", () => {
  const types = {
    project: {
      parents: ["company"],
      default_wall: "isolated" as const,
      requires_files: ["RAPPORT.md"],
    },
    client: {
      extends: "project",
      adds_fields: { contract_end: "date" },
      requires_files: [],
    },
    "client-with-own-files": {
      extends: "project",
      requires_files: ["CONTRACT.md"],
    },
  }

  it("returns the entry directly when it doesn't extend anything", () => {
    expect(resolveTypeEntry(types, "project")).toEqual(types.project)
  })

  it("inherits parents/default_wall/requires_files from the base when the child doesn't set them", () => {
    const resolved = resolveTypeEntry(types, "client")
    expect(resolved?.parents).toEqual(["company"])
    expect(resolved?.default_wall).toBe("isolated")
    expect(resolved?.requires_files).toEqual(["RAPPORT.md"])
    expect(resolved?.adds_fields).toEqual({ contract_end: "date" })
  })

  it("prefers the child's own non-empty requires_files over the base's", () => {
    const resolved = resolveTypeEntry(types, "client-with-own-files")
    expect(resolved?.requires_files).toEqual(["CONTRACT.md"])
  })

  it("returns undefined for an unknown type", () => {
    expect(resolveTypeEntry(types, "nonexistent")).toBeUndefined()
  })
})
