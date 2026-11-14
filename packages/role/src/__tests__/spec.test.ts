import { describe, it, expect } from "vitest"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import matter from "gray-matter"
import { roleSpec, roleVerbs } from "../spec.js"
import { renderRoleMd } from "../render.js"
import { defineRole } from "../define-role.js"
import type { RoleDefinition } from "../types.js"

const minimal: RoleDefinition = {
  schema: "role/v1",
  name: "synthetic-role",
  title: "Synthetic role",
  description: "A synthetic role used to test the verbs.",
  version: "1.0.0",
  seniority: "mid",
  mission: "Keep the synthetic fixtures honest.",
  responsibilities: ["Write a fixture", "Delete a fixture"],
}

const full: RoleDefinition = {
  ...minimal,
  name: "synthetic-lead",
  department: "engineering",
  reports_to: "ws://roles/synthetic-role",
  capabilities: ["triage"],
  tools: ["acme/search"],
  kpis: ["fixtures per week"],
  tags: ["synthetic"],
  slots: { reviewer: { aip: 42, description: "Who reviews" } },
}

async function withDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "role-spec-"))
  try {
    return await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

describe("roleVerbs round trip", () => {
  for (const [label, def] of [
    ["a minimal role", minimal],
    ["a role with optional fields and slots", full],
  ] as const) {
    it(`renders then parses ${label} back to the same object`, async () => {
      await withDir(async (dir) => {
        const created = await roleVerbs.create(def, { dir, body: "Synthetic prompt." })
        expect(roleSpec.parse(created.rendered).frontmatter).toEqual(def)

        const loaded = await roleVerbs.load(created.path)
        expect(loaded.handle).toEqual(created.handle)
        expect(loaded.body.trim()).toBe("Synthetic prompt.")
      })
    })
  }

  it("lists a created role and leaves an unchanged update byte-identical", async () => {
    await withDir(async (dir) => {
      const created = await roleVerbs.create(full, { dir, body: "Body." })
      expect(await roleVerbs.list(dir)).toEqual([created.handle])
      await roleVerbs.update(created.path, (p) => p)
      expect(await readFile(created.path, "utf8")).toBe(created.rendered)
    })
  })

  it("writes the role under roles/<name>/ROLE.md", async () => {
    const created = await roleVerbs.create(minimal, { dir: "/unused", dryRun: true })
    expect(created.path).toBe(join("/unused", "roles", "synthetic-role", "ROLE.md"))
  })
})

describe("renderRoleMd", () => {
  it("always writes the canonical schema tag", () => {
    const text = renderRoleMd({ role: defineRole(minimal), body: "Body." })
    expect(matter(text).data.schema).toBe("role/v1")
    expect(matter(text).content.trim()).toBe("Body.")
  })
})
