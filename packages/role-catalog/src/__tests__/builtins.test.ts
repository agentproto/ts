import { describe, expect, it } from "vitest"
import {
  defineRole,
  resolveRole,
  type RoleHandle,
} from "@agentproto/role"
import {
  BUILTIN_ROLE_ENTRIES,
  BUILTIN_ROLE_SLUGS,
  LEGACY_GUILDE_ROLE_MAP,
  builtinRoleSource,
  registerBuiltinRoles,
  replaceBuiltinRole,
  unregisterBuiltinRole,
} from "../index.js"

describe("@agentproto/role-catalog builtins", () => {
  it("ships twenty-one builtin roles covering the recommended departments", () => {
    expect(BUILTIN_ROLE_ENTRIES).toHaveLength(21)
    expect(BUILTIN_ROLE_SLUGS).toHaveLength(21)
  })

  it("every builtin validates against defineRole", () => {
    for (const entry of BUILTIN_ROLE_ENTRIES) {
      expect(() => defineRole(entry.handle)).not.toThrow()
    }
  })

  it("every builtin has a non-empty body", () => {
    for (const entry of BUILTIN_ROLE_ENTRIES) {
      expect(entry.body).toBeTruthy()
      expect(entry.body!.length).toBeGreaterThan(50)
    }
  })

  it("slugs are unique across the catalogue", () => {
    const set = new Set(BUILTIN_ROLE_SLUGS)
    expect(set.size).toBe(BUILTIN_ROLE_SLUGS.length)
  })

  it("reports_to refs point to other builtins", () => {
    const slugSet = new Set(BUILTIN_ROLE_SLUGS)
    for (const entry of BUILTIN_ROLE_ENTRIES) {
      const ref = entry.handle.reports_to
      if (!ref) continue
      // Strip ws://roles/ prefix to compare to slug
      const slug = ref.replace(/^ws:\/\/roles\//, "")
      expect(slugSet.has(slug)).toBe(true)
    }
  })

  it("ships departments aligned with AIP-47's recommended values", () => {
    const allowed = new Set([
      "executive",
      "marketing",
      "product",
      "engineering",
      "sales",
      "customer",
      "operations",
      "finance",
      "people",
    ])
    for (const entry of BUILTIN_ROLE_ENTRIES) {
      expect(allowed.has(entry.handle.department!)).toBe(true)
    }
  })

  it("ships the four C-suite manifests alongside manager-level roles", () => {
    // Per the doctype-agnostic invariant in AIP-47: C-suite roles are
    // in the catalogue and ANY actor (operator or human member) can
    // wear them. We just assert presence here; positioning ("AI CEO is
    // rare in 2026") is a curation concern in consumer UIs, not a
    // schema property of the manifest.
    const cSuiteSlugs = [
      "chief-executive-officer",
      "chief-marketing-officer",
      "chief-technology-officer",
      "chief-financial-officer",
    ]
    for (const slug of cSuiteSlugs) {
      const entry = BUILTIN_ROLE_ENTRIES.find((e) => e.slug === slug)
      expect(entry, `expected ${slug} in the catalogue`).toBeDefined()
    }
  })

  it("legacy Guilde role map covers every VALID_ROLES enum value", () => {
    const legacy = ["ceo", "cmo", "cto", "cfo", "copywriter", "visual", "analytics", "research", "editor", "performance"]
    for (const old of legacy) {
      expect(LEGACY_GUILDE_ROLE_MAP[old]).toBeDefined()
      // Every mapping target MUST exist in the catalogue.
      expect(BUILTIN_ROLE_SLUGS).toContain(LEGACY_GUILDE_ROLE_MAP[old])
    }
  })
})

describe("builtinRoleSource()", () => {
  it("resolves a leaf role through the source", async () => {
    const result = await resolveRole("marketing-manager", {
      sources: [builtinRoleSource()],
    })
    expect(result.role.name).toBe("marketing-manager")
    expect(result.role.department).toBe("marketing")
    expect(result.role.seniority).toBe("lead")
    expect(result.warnings).toHaveLength(0)
  })

  it("resolves every builtin without warnings", async () => {
    const source = builtinRoleSource()
    for (const slug of BUILTIN_ROLE_SLUGS) {
      const result = await resolveRole(slug, { sources: [source] })
      expect(result.role.name).toBe(slug)
      // Warnings from cross-ref resolution (reports_to) MAY appear
      // when those refs point at sibling builtins not yet in the
      // chain — that's by design (the catalogue ships refs that the
      // consumer's full source chain resolves). At catalogue scope,
      // we expect zero MERGE warnings.
      const mergeCodes = ["role_merge_form_conflict", "role_merge_remove_missed"]
      for (const w of result.warnings) {
        expect(mergeCodes).not.toContain(w.code)
      }
    }
  })

  it("returns the SAME singleton across calls (process-wide registry)", () => {
    expect(builtinRoleSource()).toBe(builtinRoleSource())
  })
})

describe("registerBuiltinRoles + replace + unregister", () => {
  // Test slug — unique per test to avoid colliding with the shared
  // singleton across runs (vitest in worker mode shares the module).
  const TEST_SLUG = "test-extension-role"
  const TEST_HANDLE: RoleHandle = {
    schema: "role/v1",
    name: TEST_SLUG,
    title: "Test Extension Role",
    description: "A role registered for testing the extension API.",
    version: "1.0.0",
    seniority: "mid",
    mission: "Demonstrate that downstream apps can extend the builtin catalogue.",
    responsibilities: ["Exist for the duration of the test", "Be cleaned up"],
  }

  it("registers a downstream entry, resolves through the singleton, then unregisters", async () => {
    expect(builtinRoleSource().has(TEST_SLUG)).toBe(false)

    registerBuiltinRoles([
      { slug: TEST_SLUG, handle: TEST_HANDLE, body: "## Body\n\nHello." },
    ])

    expect(builtinRoleSource().has(TEST_SLUG)).toBe(true)

    const resolved = await resolveRole(TEST_SLUG, {
      sources: [builtinRoleSource()],
    })
    expect(resolved.role.name).toBe(TEST_SLUG)
    expect(resolved.role.title).toBe("Test Extension Role")
    expect(resolved.body).toContain("Hello.")

    expect(unregisterBuiltinRole(TEST_SLUG)).toBe(true)
    expect(builtinRoleSource().has(TEST_SLUG)).toBe(false)
  })

  it("replaces an existing entry atomically", () => {
    registerBuiltinRoles([
      { slug: TEST_SLUG, handle: TEST_HANDLE, body: "v1" },
    ])

    const updated: RoleHandle = {
      ...TEST_HANDLE,
      title: "Test Extension Role (v2)",
      version: "1.1.0",
    }
    replaceBuiltinRole({ slug: TEST_SLUG, handle: updated, body: "v2" })

    const entry = builtinRoleSource().registry.get(TEST_SLUG)
    expect(entry?.handle.title).toBe("Test Extension Role (v2)")
    expect(entry?.body).toBe("v2")

    unregisterBuiltinRole(TEST_SLUG)
  })

  it("rejects duplicate registration of the same slug", () => {
    registerBuiltinRoles([
      { slug: TEST_SLUG, handle: TEST_HANDLE, body: "" },
    ])

    expect(() =>
      registerBuiltinRoles([
        { slug: TEST_SLUG, handle: TEST_HANDLE, body: "" },
      ]),
    ).toThrow(/already registered/)

    unregisterBuiltinRole(TEST_SLUG)
  })

  it("lookup() filters entries by predicate", () => {
    // Use a title-level discriminator to validate the predicate API.
    // Four roles end with "Officer" (CEO, CMO, CTO, CFO); chief-of-staff
    // ends with "Staff", so the predicate cleanly isolates the C-suite.
    const cSuite = builtinRoleSource().lookup((e) =>
      e.handle.title.endsWith("Officer"),
    )
    expect(cSuite.length).toBe(4)
  })
})
