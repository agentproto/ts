import { describe, expect, it } from "vitest"
import { resolveRole } from "../resolve.js"
import { BuiltinRoleSource } from "../sources/builtin.js"
import type { RoleHandle } from "../types.js"

const seoSpecialist: RoleHandle = {
  schema: "role/v1",
  name: "seo-specialist",
  title: "Senior SEO Specialist",
  description: "Drives organic traffic.",
  version: "1.0.0",
  department: "marketing",
  seniority: "senior",
  mission: "Drive organic traffic.",
  responsibilities: ["Keyword research", "On-page audits"],
  tools: ["ws://tools/ahrefs"],
  kpis: ["organic-traffic-growth"],
  metadata: {},
}

const ourSeo: RoleHandle = {
  schema: "role/v1",
  name: "our-seo-specialist",
  title: "SEO Specialist (Brand)",
  description: "Brand-aligned SEO operator.",
  version: "1.0.0",
  seniority: "senior",
  mission: "Brand-aligned organic growth.",
  responsibilities: ["Keyword research"], // overlaps for dedupe test
  extends: "builtin/seo-specialist",
  metadata: { guilde: { visibility: "org" } },
} as RoleHandle

describe("resolveRole (AIP-47)", () => {
  it("resolves a leaf-only role (no extends)", async () => {
    const source = new BuiltinRoleSource([
      { slug: "seo-specialist", handle: seoSpecialist, body: "# SEO body" },
    ])

    const result = await resolveRole("seo-specialist", { sources: [source] })

    expect(result.role.name).toBe("seo-specialist")
    expect(result.role.responsibilities).toEqual([
      "Keyword research",
      "On-page audits",
    ])
    expect(result.body).toBe("# SEO body")
    expect(result.chain).toEqual(["builtin/seo-specialist"])
    expect(result.warnings).toHaveLength(0)
  })

  it("walks `extends` chain and merges with strategic-merge", async () => {
    const source = new BuiltinRoleSource([
      { slug: "seo-specialist", handle: seoSpecialist, body: "# parent" },
      { slug: "our-seo-specialist", handle: ourSeo, body: "## child" },
    ])

    const result = await resolveRole("our-seo-specialist", {
      sources: [source],
    })

    // Merged: parent's responsibilities replaced by child's plain list (per spec)
    expect(result.role.responsibilities).toEqual(["Keyword research"])
    // Mission overrides
    expect(result.role.mission).toBe("Brand-aligned organic growth.")
    // Inherited from parent
    expect(result.role.tools).toEqual(["ws://tools/ahrefs"])
    expect(result.role.department).toBe("marketing")
    // Metadata deep-merged
    expect(result.role.metadata).toEqual({ guilde: { visibility: "org" } })
    // Body appended
    expect(result.body).toBe("# parent\n\n---\n\n## child")
    // Chain ordered leaf→root
    expect(result.chain).toEqual([
      "builtin/our-seo-specialist",
      "builtin/seo-specialist",
    ])
  })

  it("throws role_unresolvable when leaf does not resolve", async () => {
    const source = new BuiltinRoleSource([])
    await expect(
      resolveRole("missing-role", { sources: [source] }),
    ).rejects.toMatchObject({ message: expect.stringContaining("missing-role") })
  })

  it("falls back to local manifest when parent is missing (warning, not error)", async () => {
    const source = new BuiltinRoleSource([
      { slug: "our-seo-specialist", handle: ourSeo, body: "## child" },
      // intentionally NOT including seo-specialist parent
    ])

    const result = await resolveRole("our-seo-specialist", {
      sources: [source],
    })

    expect(result.role.name).toBe("our-seo-specialist")
    expect(result.warnings).toContainEqual(
      expect.objectContaining({
        code: "role_extends_missing",
        parent: "builtin/seo-specialist",
      }),
    )
  })

  it("detects cycles in extends chain", async () => {
    const a: RoleHandle = {
      ...seoSpecialist,
      name: "a",
      extends: "builtin/b",
    } as RoleHandle
    const b: RoleHandle = {
      ...seoSpecialist,
      name: "b",
      extends: "builtin/a",
    } as RoleHandle

    const source = new BuiltinRoleSource([
      { slug: "a", handle: a, body: "" },
      { slug: "b", handle: b, body: "" },
    ])

    const result = await resolveRole("a", { sources: [source] })
    expect(result.warnings.map((w) => w.code)).toContain("role_extends_cycle")
  })

  it("caps depth at maxDepth and warns", async () => {
    // Chain of 10 roles, each extending the next, with maxDepth=3.
    const roles = Array.from({ length: 10 }, (_, i): RoleHandle => ({
      ...seoSpecialist,
      name: `r${i}`,
      extends: i < 9 ? `builtin/r${i + 1}` : undefined,
    }))
    const source = new BuiltinRoleSource(
      roles.map((r) => ({ slug: r.name, handle: r })),
    )

    const result = await resolveRole("r0", {
      sources: [source],
      maxDepth: 3,
    })

    expect(result.warnings.map((w) => w.code)).toContain(
      "role_extends_depth_exceeded",
    )
  })

  it("first match wins across source chain", async () => {
    const fileVariant: RoleHandle = {
      ...seoSpecialist,
      title: "From File",
    } as RoleHandle
    const builtinVariant: RoleHandle = {
      ...seoSpecialist,
      title: "From Builtin",
    } as RoleHandle

    // Inline source impl typed under a different scheme than builtin —
    // exercises the chain's first-match-wins semantics.
    const fileSource = {
      scheme: "file" as const,
      load: async (ref: string) =>
        ref === "seo-specialist"
          ? {
              ref: `file/${ref}`,
              frontmatter: fileVariant,
              body: "",
              scheme: "file",
            }
          : null,
    }
    const builtinSource = new BuiltinRoleSource([
      { slug: "seo-specialist", handle: builtinVariant },
    ])

    const result = await resolveRole("seo-specialist", {
      sources: [fileSource, builtinSource],
    })
    expect(result.role.title).toBe("From File")
  })
})
