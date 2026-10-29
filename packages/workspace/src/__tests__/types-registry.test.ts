import { describe, it, expect } from "vitest"
import { parseTypesManifest, writeTypesManifest, resolveTypeEntry, validateTypesRegistry } from "../types-registry.js"

describe("TYPES.md round-trip", () => {
  it("writes and parses back the same registry", () => {
    const md = writeTypesManifest({
      schema: "workspace-types/v1",
      types: {
        root: { parents: [], max_per_tree: 1 },
        project: { parents: ["root"], default_wall: "isolated", requires_files: ["RAPPORT.md"] },
      },
    })
    expect(md).toContain("schema: workspace.types/v1")
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

  it("writes the canonical tag even when handed the legacy one", () => {
    const md = writeTypesManifest({ schema: "workspace-types/v1", types: { root: { parents: [] } } })
    expect(md).toContain("schema: workspace.types/v1")
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

describe("resolveTypeEntry — extends inheritance (AIP-34 TYPES.md)", () => {
  const types = {
    project: {
      parents: ["company"],
      default_wall: "isolated" as const,
      max_per_tree: 5,
      requires_files: ["RAPPORT.md"],
      starter: { agents: [{ template: "@pygmalion/staff/project-lead" }] },
      adds_fields: { budget: "number" },
    },
    guild: { extends: "project", requires_files: [] },
    "guild-sealed": { extends: "guild", default_wall: "sealed" as const, requires_files: [] },
  }

  it("inherits every inheritable field a type leaves unset", () => {
    const resolved = resolveTypeEntry(types, "guild")
    expect(resolved?.parents).toEqual(["company"])
    expect(resolved?.default_wall).toBe("isolated")
    expect(resolved?.max_per_tree).toBe(5)
    expect(resolved?.requires_files).toEqual(["RAPPORT.md"])
    expect(resolved?.starter?.agents).toEqual([{ template: "@pygmalion/staff/project-lead" }])
    expect(resolved?.adds_fields).toEqual({ budget: "number" })
  })

  it("resolves through a chain and lets a field the type sets replace the inherited one", () => {
    const resolved = resolveTypeEntry(types, "guild-sealed")
    expect(resolved?.default_wall).toBe("sealed")
    expect(resolved?.parents).toEqual(["company"])
    expect(resolved?.starter?.agents).toHaveLength(1)
  })
})

describe("validateTypesRegistry", () => {
  const entry = { requires_files: [] as string[] }

  it("reports nothing for a registry whose extends all resolve", () => {
    expect(validateTypesRegistry({ project: entry, guild: { ...entry, extends: "project" } })).toEqual([])
  })

  it("reports an extends cycle through several types, once", () => {
    const issues = validateTypesRegistry({
      a: { ...entry, extends: "b" },
      b: { ...entry, extends: "c" },
      c: { ...entry, extends: "a" },
    })
    expect(issues).toHaveLength(1)
    expect(issues[0]).toMatchObject({ kind: "extends-cycle", cycle: ["a", "b", "c", "a"] })
  })

  it("reports a type that extends itself", () => {
    const issues = validateTypesRegistry({ a: { ...entry, extends: "a" } })
    expect(issues).toMatchObject([{ kind: "extends-cycle", cycle: ["a", "a"] }])
  })

  it("reports a type that extends into a cycle without being on it", () => {
    const issues = validateTypesRegistry({
      x: { ...entry, extends: "a" },
      a: { ...entry, extends: "b" },
      b: { ...entry, extends: "a" },
    })
    expect(issues).toHaveLength(1)
    expect(issues[0]).toMatchObject({ kind: "extends-cycle", cycle: ["a", "b", "a"] })
  })

  it("reports an extends that names an undeclared type", () => {
    const issues = validateTypesRegistry({ guild: { ...entry, extends: "projet" } })
    expect(issues).toMatchObject([{ kind: "unknown-parent", type: "guild", extends: "projet" }])
  })

  it("resolveTypeEntry terminates on a cycle instead of overflowing the stack", () => {
    const cyclic = { a: { ...entry, extends: "b" }, b: { ...entry, extends: "a" } }
    expect(() => resolveTypeEntry(cyclic, "a")).not.toThrow()
  })
})
