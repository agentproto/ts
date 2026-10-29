import { describe, it, expect } from "vitest"
import { defineCompany } from "../define-company.js"
import { companyFromManifest, parseCompanyManifest } from "../manifest/index.js"
import { companyPositions } from "../structure.js"
import type { CompanyDefinition } from "../types.js"

const company = (fields: Record<string, unknown>): CompanyDefinition =>
  ({
    schema: "company/v1",
    name: "Synthetic Co",
    mission: "Ship synthetic things.",
    ...fields,
  }) as unknown as CompanyDefinition

describe("defineCompany: kind and slug are aliases of doctype and id", () => {
  it("reads kind as doctype and slug as id", () => {
    const handle = defineCompany(company({ kind: "company", slug: "synthetic-co" }))
    expect(handle.doctype).toBe("company")
    expect(handle.id).toBe("synthetic-co")
    expect(handle).not.toHaveProperty("kind")
    expect(handle).not.toHaveProperty("slug")
  })

  it("reads an objective written with the aliases", () => {
    const handle = defineCompany({
      schema: "company/v1",
      kind: "objective",
      slug: "grow",
      statement: "Grow the synthetic base.",
    } as unknown as CompanyDefinition)
    expect(handle.doctype).toBe("objective")
    expect(handle.id).toBe("grow")
  })

  it("reads the aliases from a COMPANY.md", () => {
    const text = [
      "---",
      "schema: company/v1",
      "kind: company",
      "slug: synthetic-co",
      "name: Synthetic Co",
      "mission: Ship synthetic things.",
      "---",
      "",
    ].join("\n")
    const handle = companyFromManifest(parseCompanyManifest(text))
    expect(handle.doctype).toBe("company")
    expect(handle.id).toBe("synthetic-co")
  })

  it("accepts an alias that repeats its canonical field", () => {
    const handle = defineCompany(
      company({ doctype: "company", kind: "company", id: "synthetic-co", slug: "synthetic-co" }),
    )
    expect(handle.doctype).toBe("company")
    expect(handle.id).toBe("synthetic-co")
  })

  it("refuses doctype and kind that name different doctypes with alias_conflict", () => {
    const def = company({ doctype: "company", kind: "objective", id: "synthetic-co" })
    expect(() => defineCompany(def)).toThrow(/alias_conflict/)
  })

  it("refuses id and slug that differ with alias_conflict", () => {
    const def = company({ doctype: "company", id: "synthetic-co", slug: "other-co" })
    expect(() => defineCompany(def)).toThrow(/alias_conflict/)
  })

  it("refuses a COMPANY.md whose id and slug differ with alias_conflict", () => {
    const text = [
      "---",
      "schema: company/v1",
      "doctype: company",
      "id: synthetic-co",
      "slug: other-co",
      "name: Synthetic Co",
      "mission: Ship synthetic things.",
      "---",
      "",
    ].join("\n")
    expect(() => parseCompanyManifest(text)).toThrow(/alias_conflict/)
  })

  it("refuses a file that carries neither doctype nor kind", () => {
    expect(() => defineCompany(company({ id: "synthetic-co" }))).toThrow(/doctype/)
  })
})

describe("defineCompany: structure.positions, roles and reports_to are deprecated", () => {
  it("still accepts and reads them", () => {
    const handle = defineCompany(
      company({
        doctype: "company",
        id: "synthetic-co",
        structure: {
          roles: ["seat-a"],
          reports_to: { "seat-a": "seat-b" },
          objectives: ["grow"],
        },
      }),
    )
    expect(companyPositions(handle as never)).toEqual(["seat-a"])
  })
})

describe("legacy `doctype: role` under company/v1", () => {
  const legacyRole = {
    schema: "company/v1",
    doctype: "role",
    id: "synthetic-seat",
    mandate: "Own the synthetic backlog.",
  }

  it("is read with a doctype_moved warning", () => {
    const handle = defineCompany(legacyRole as unknown as CompanyDefinition)
    expect(handle.doctype).toBe("role")
    expect(handle.warnings.map((w) => w.code)).toEqual(["doctype_moved"])
  })

  it("is read from a COMPANY.md-style file with the same warning", () => {
    const text = [
      "---",
      "schema: company/v1",
      "kind: role",
      "slug: synthetic-seat",
      "mandate: Own the synthetic backlog.",
      "---",
      "",
    ].join("\n")
    const handle = companyFromManifest(parseCompanyManifest(text))
    expect(handle.warnings.map((w) => w.code)).toEqual(["doctype_moved"])
    expect(handle.id).toBe("synthetic-seat")
  })

  it("does not warn on a company or an objective", () => {
    expect(defineCompany(company({ doctype: "company", id: "synthetic-co" })).warnings).toEqual([])
  })
})
