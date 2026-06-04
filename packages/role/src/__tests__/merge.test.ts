import { describe, expect, it } from "vitest"
import { mergeBodies, mergeRoles } from "../merge.js"
import type { RoleHandle } from "../types.js"

const parent: RoleHandle = {
  schema: "role/v1",
  name: "seo-specialist",
  title: "Senior SEO Specialist",
  description: "Drives organic traffic.",
  version: "1.0.0",
  seniority: "senior",
  mission: "Drive organic traffic.",
  responsibilities: ["Keyword research", "On-page audits"],
  capabilities: ["SEO diagnostics"],
  tools: ["ws://tools/ahrefs", "ws://tools/google-search-console"],
  skills: ["ws://skills/keyword-research"],
  kpis: ["organic-traffic-growth", "keyword-ranking-delta"],
  strengths: ["Pattern recognition"],
  antiPatterns: ["Publishing without sign-off"],
  tags: ["seo", "marketing"],
  metadata: { guilde: { visibility: "public" } },
}

describe("mergeRoles (AIP-47)", () => {
  describe("append-and-dedupe lists", () => {
    it("appends child responsibilities to parent's", () => {
      const { role, warnings } = mergeRoles(parent, {
        responsibilities: { add: ["Brand-voice alignment"] },
      })
      expect(role.responsibilities).toEqual([
        "Keyword research",
        "On-page audits",
        "Brand-voice alignment",
      ])
      expect(warnings).toHaveLength(0)
    })

    it("dedupes additions that already exist in parent", () => {
      const { role } = mergeRoles(parent, {
        responsibilities: { add: ["Keyword research", "Brand alignment"] },
      })
      expect(role.responsibilities).toEqual([
        "Keyword research",
        "On-page audits",
        "Brand alignment",
      ])
    })

    it("removes exact-string matches from inherited list", () => {
      const { role } = mergeRoles(parent, {
        kpis: { remove: ["organic-traffic-growth"], add: ["branded-organic-traffic-growth"] },
      })
      expect(role.kpis).toEqual([
        "keyword-ranking-delta",
        "branded-organic-traffic-growth",
      ])
    })

    it("warns when a `remove` entry does not match", () => {
      const { warnings } = mergeRoles(parent, {
        kpis: { remove: ["never-was-there"] },
      })
      expect(warnings).toContainEqual(
        expect.objectContaining({
          code: "role_merge_remove_missed",
          field: "kpis",
          missing: "never-was-there",
        }),
      )
    })

    it("replaces the inherited list entirely when child uses plain-array form", () => {
      const { role } = mergeRoles(parent, {
        tools: ["ws://tools/brand-voice"],
      })
      expect(role.tools).toEqual(["ws://tools/brand-voice"])
    })
  })

  describe("scalar overrides", () => {
    it("child seniority replaces parent's", () => {
      const { role } = mergeRoles(parent, { seniority: "lead" })
      expect(role.seniority).toBe("lead")
    })

    it("child mission replaces parent's when set", () => {
      const { role } = mergeRoles(parent, { mission: "Lead the SEO function." })
      expect(role.mission).toBe("Lead the SEO function.")
    })

    it("keeps parent value when child does not provide", () => {
      const { role } = mergeRoles(parent, {})
      expect(role.title).toBe(parent.title)
      expect(role.seniority).toBe(parent.seniority)
    })
  })

  describe("local-only fields", () => {
    it("does NOT inherit `extends` from parent", () => {
      const ancestorChain: RoleHandle = {
        ...parent,
        extends: "../grandparent/ROLE.md",
      }
      const { role } = mergeRoles(ancestorChain, { name: "child" })
      expect(role.extends).toBeUndefined()
    })

    it("does NOT inherit `appliesTo` from parent", () => {
      const ancestorWithApply: RoleHandle = {
        ...parent,
        appliesTo: ["ws://operators/sarah"],
      }
      const { role } = mergeRoles(ancestorWithApply, { name: "child" })
      expect(role.appliesTo).toBeUndefined()
    })

    it("carries child's own appliesTo through merge", () => {
      const { role } = mergeRoles(parent, {
        appliesTo: ["ws://operators/sarah"],
      })
      expect(role.appliesTo).toEqual(["ws://operators/sarah"])
    })
  })

  describe("default bindings (override semantics)", () => {
    it("child defaultPolicy overrides parent's", () => {
      const withPolicy: RoleHandle = {
        ...parent,
        defaultPolicy: "ws://policies/seo-baseline",
      }
      const { role } = mergeRoles(withPolicy, {
        defaultPolicy: "ws://policies/brand-aligned",
      })
      expect(role.defaultPolicy).toBe("ws://policies/brand-aligned")
    })
  })

  describe("metadata deep-merge", () => {
    it("merges vendor namespaces recursively, child keys win", () => {
      const { role } = mergeRoles(parent, {
        metadata: { guilde: { visibility: "org", organizationId: "org_x" } },
      })
      expect(role.metadata).toEqual({
        guilde: { visibility: "org", organizationId: "org_x" },
      })
    })
  })

  describe("knowledge.packs (append-and-dedupe across lineage)", () => {
    const withPacks: RoleHandle = {
      ...parent,
      knowledge: { packs: ["seo-specialist", "rgpd"] },
    }

    it("unions child packs onto the inherited floor, deduped", () => {
      const { role } = mergeRoles(withPacks, {
        knowledge: { packs: ["rgpd", "geo"] },
      })
      expect(role.knowledge?.packs).toEqual(["seo-specialist", "rgpd", "geo"])
    })

    it("inherits the parent's packs when the child declares none", () => {
      const { role } = mergeRoles(withPacks, {})
      expect(role.knowledge?.packs).toEqual(["seo-specialist", "rgpd"])
    })

    it("introduces a knowledge block from the child when the parent has none", () => {
      const { role } = mergeRoles(parent, {
        knowledge: { packs: ["elon-tweets"] },
      })
      expect(role.knowledge?.packs).toEqual(["elon-tweets"])
    })

    it("emits no knowledge block when neither layer declares one", () => {
      const { role } = mergeRoles(parent, {})
      expect(role.knowledge).toBeUndefined()
    })
  })
})

describe("mergeBodies (AIP-47)", () => {
  it("appends with separator by default", () => {
    // Parent's trailing whitespace is trimmed; child's leading whitespace is trimmed.
    // Child's own trailing newline is preserved verbatim (markdown convention).
    expect(mergeBodies("# parent\n\n", "## child\n")).toBe(
      "# parent\n\n---\n\n## child\n",
    )
  })

  it("replaces when mode is replace", () => {
    expect(mergeBodies("parent", "child", "replace")).toBe("child")
  })

  it("returns child when parent is empty", () => {
    expect(mergeBodies(undefined, "child")).toBe("child")
  })

  it("returns parent when child is empty", () => {
    expect(mergeBodies("parent", undefined)).toBe("parent")
  })
})
