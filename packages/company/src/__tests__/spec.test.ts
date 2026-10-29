import { describe, it, expect } from "vitest"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import matter from "gray-matter"
import { companySpec, companyVerbs } from "../spec.js"
import { renderCompanyMd } from "../render.js"
import type { CompanyDefinition } from "../types.js"

const company = {
  schema: "company/v1",
  doctype: "company",
  id: "synthetic-co",
  version: "1.0.0",
  name: "Synthetic Co",
  description: "A synthetic company.",
  tags: ["synthetic"],
  metadata: { vendor: { key: 1 } },
  mission: "Ship synthetic things.",
  values: ["be kind"],
  structure: { objectives: ["grow"] },
  imports: [{ from: "./shared/seat", as: "role", id: "seat-imp" }],
} as unknown as CompanyDefinition

const objective = {
  schema: "company/v1",
  doctype: "objective",
  id: "grow",
  statement: "Grow the synthetic base.",
  owner: "seat-a",
  horizon: "year",
  status: "active",
  key_results: [{ id: "kr-one", statement: "Reach ten.", target: "10", progress: 0.5 }],
  children: ["grow-sub"],
  depends_on: ["stabilise"],
} as unknown as CompanyDefinition

async function withDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "company-spec-"))
  try {
    return await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

describe("companyVerbs round trip", () => {
  for (const [label, def] of [
    ["company", company],
    ["objective", objective],
  ] as const) {
    it(`renders then parses a ${label} back to the same object`, async () => {
      await withDir(async (dir) => {
        const created = await companyVerbs.create(def, { dir, body: "Synthetic body." })
        expect(companySpec.parse(created.rendered).frontmatter).toEqual(def)

        const loaded = await companyVerbs.load(created.path)
        expect(loaded.handle).toEqual(created.handle)
        expect(loaded.body.trim()).toBe("Synthetic body.")
      })
    })
  }

  it("lists a created company and leaves an unchanged update byte-identical", async () => {
    await withDir(async (dir) => {
      const created = await companyVerbs.create(company, { dir, body: "Synthetic body." })
      expect(await companyVerbs.list(dir)).toEqual([created.handle])
      await companyVerbs.update(created.path, (p) => p)
      expect(await readFile(created.path, "utf8")).toBe(created.rendered)
    })
  })
})

describe("company writers emit canonical fields only", () => {
  const legacyShaped = {
    schema: "agentcompanies/v1",
    kind: "company",
    slug: "synthetic-co",
    name: "Synthetic Co",
    mission: "Ship synthetic things.",
    structure: {
      positions: ["seat-a"],
      roles: ["seat-a"],
      reports_to: { "seat-a": "seat-b" },
      objectives: ["grow"],
    },
  } as unknown as CompanyDefinition

  it("writes doctype and id, never kind or slug", async () => {
    const created = await companyVerbs.create(legacyShaped, { dir: "/unused", dryRun: true })
    const data = matter(created.rendered).data
    expect(data.doctype).toBe("company")
    expect(data.id).toBe("synthetic-co")
    expect(data).not.toHaveProperty("kind")
    expect(data).not.toHaveProperty("slug")
    expect(data.schema).toBe("company/v1")
  })

  it("writes no structure.positions, structure.roles or structure.reports_to", async () => {
    const created = await companyVerbs.create(legacyShaped, { dir: "/unused", dryRun: true })
    const structure = matter(created.rendered).data.structure ?? {}
    expect(structure).not.toHaveProperty("positions")
    expect(structure).not.toHaveProperty("roles")
    expect(structure).not.toHaveProperty("reports_to")
    expect(structure.objectives).toEqual(["grow"])
  })

  it("does not write the warnings of a handle", async () => {
    const created = await companyVerbs.create(company, { dir: "/unused", dryRun: true })
    expect(matter(created.rendered).data).not.toHaveProperty("warnings")
  })

  it("refuses to write a legacy role file as a company document", () => {
    const legacyRole = {
      schema: "company/v1",
      doctype: "role",
      id: "synthetic-seat",
      mandate: "Own the synthetic backlog.",
    } as unknown as CompanyDefinition
    expect(() => renderCompanyMd({ company: companySpec.define(legacyRole) })).toThrow(/role\/v1/)
  })
})
