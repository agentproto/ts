/**
 * AIP-40 v2 — selective composition tests.
 *
 * Covers the two new mechanisms: `remove_fields` (guarded) and
 * `inherit` per-aspect selection. Backward compat (omitted config =
 * v1 wholesale behavior) is asserted in spec-from-extension.test.ts's
 * existing cases — those passing unchanged IS the compat guarantee.
 */
import { describe, it, expect } from "vitest"
import type { DoctypeSpec } from "@agentproto/manifest"
import { defineExtension } from "../define-extension.js"
import { specFromExtension } from "../spec-from-extension.js"

interface AppParams {
  id: string
  description: string
  agents?: string[]
  workflows?: string[]
  category?: string
}
type AppHandleT = Readonly<AppParams>

const appParentSpec: DoctypeSpec<AppParams, AppHandleT> = {
  name: "app",
  aip: 42,
  schemaLiteral: "app/v1",
  pathOf: h => `${h.id}/APP.md`,
  define: params =>
    Object.freeze({
      id: params.id,
      description: params.description,
      agents: params.agents ?? [],
      workflows: params.workflows ?? [],
      category: params.category,
    }),
  parse: () => ({ frontmatter: { from: "parent" }, body: "" }),
}

/** Jeremy's scenario: keep identity, drop agents/workflows, add a price. */
const leanProductExt = defineExtension({
  schema: "agentproto/extension/v1",
  slug: "acme:lean-app",
  title: "Lean app — identity only, priced",
  description: "App identity without agents/workflows, plus a price field.",
  version: "1.0.0",
  status: "Local",
  extends: "aip-42",
  remove_fields: ["agents", "workflows"],
  inherit: { parse: false },
  add_fields: {
    properties: {
      price: { type: "object" },
    },
  },
  path_convention: "products/<slug>.md",
})

describe("AIP-40 v2 — remove_fields", () => {
  it("keeps identity, drops agents/workflows, adds a price", () => {
    const spec = specFromExtension(leanProductExt, {
      parent: appParentSpec,
      parentRequired: ["id", "description"],
      parse: src => ({ frontmatter: JSON.parse(src), body: "" }),
    })
    const h = spec.define({
      id: "lean-app",
      description: "identity only",
      price: { model: "one-time", amountMinor: 1 },
      // agents deliberately absent — they were removed from the schema
    } as AppParams)
    expect(h).toHaveProperty("price")
    expect(h).toHaveProperty("id")
  })

  it("removed fields are ENFORCED away — input carrying one is a composition violation", () => {
    const spec = specFromExtension(leanProductExt, {
      parent: appParentSpec,
      parentRequired: ["id", "description"],
      parse: () => ({ frontmatter: {}, body: "" }),
    })
    expect(() =>
      spec.define({
        id: "x",
        description: "d",
        agents: ["should-not-be-here"],
      } as AppParams),
    ).toThrow(/was removed by extension/)
  })

  it("GUARD: removing a parent-required field is refused at registration", () => {
    const guardedExt = defineExtension({
      schema: "agentproto/extension/v1",
      slug: "acme:bad-removal",
      title: "Tries to drop identity",
      description: "Must be refused — id is parent-required.",
      version: "1.0.0",
      status: "Local",
      extends: "aip-42",
      remove_fields: ["id"],
    })
    expect(() =>
      specFromExtension(guardedExt, {
        parent: appParentSpec,
        parentRequired: ["id", "description"],
      }),
    ).toThrow(/required by the parent/)
  })

  it("removal is permissive when the host does not declare parent required[] (documented limitation)", () => {
    // No parentRequired passed — the guard can't fire (the manifest
    // layer's schema isn't introspectable from here). The removal still
    // applies at define-time. (lean-app also sets inherit.parse: false,
    // so a replacement parser is supplied to satisfy that validation.)
    const spec = specFromExtension(leanProductExt, {
      parent: appParentSpec,
      parse: () => ({ frontmatter: {}, body: "" }),
    })
    expect(spec).toBeDefined()
  })
})

describe("AIP-40 v2 — per-aspect inherit", () => {
  it("inherit.parse: false swaps in the supplied parser", () => {
    const spec = specFromExtension(leanProductExt, {
      parent: appParentSpec,
      parentRequired: ["id", "description"],
      parse: src => ({ frontmatter: JSON.parse(src), body: "" }),
    })
    expect(spec.parse('{"id":"x"}').frontmatter).toEqual({ id: "x" })
    expect(spec.parse).not.toBe(appParentSpec.parse)
  })

  it("inherit.parse: false WITHOUT a replacement parser is refused at registration", () => {
    expect(() => specFromExtension(leanProductExt, { parent: appParentSpec })).toThrow(
      /no replacement parser/,
    )
  })

  it("inherit.path: false requires path_convention", () => {
    const ext = defineExtension({
      schema: "agentproto/extension/v1",
      slug: "acme:no-path-inherit",
      title: "No path inheritance",
      description: "Supplies its own path but forgot path_convention.",
      version: "1.0.0",
      status: "Local",
      extends: "aip-42",
      inherit: { path: false },
    })
    expect(() => specFromExtension(ext, { parent: appParentSpec })).toThrow(
      /declares no path_convention/,
    )
  })

  it("inherit.schema: false makes add_fields the whole schema (root-like define)", () => {
    const ext = defineExtension({
      schema: "agentproto/extension/v1",
      slug: "acme:fresh",
      title: "Fresh doctype from a parent's ashes",
      description: "Takes nothing from the parent's schema.",
      version: "1.0.0",
      status: "Local",
      extends: "aip-42",
      inherit: { schema: false },
    })
    const spec = specFromExtension(ext, { parent: appParentSpec })
    // parent-required-ish fields are NOT auto-included; define passes through
    const h = spec.define({ id: "only-mine" } as AppParams)
    expect((h as { id?: string }).id).toBe("only-mine")
    expect(h).not.toHaveProperty("agents")
  })

  it("v1 back-compat: omitted inherit/remove_fields = wholesale inheritance", () => {
    const ext = defineExtension({
      schema: "agentproto/extension/v1",
      slug: "acme:v1-style",
      title: "v1 style",
      description: "No selective config at all.",
      version: "1.0.0",
      status: "Local",
      extends: "aip-42",
    })
    const spec = specFromExtension(ext, { parent: appParentSpec })
    // parse still the parent's; pathOf still the parent's; defaults still layered
    expect(spec.parse).toBe(appParentSpec.parse)
    expect(spec.pathOf({ id: "z" } as AppHandleT)).toBe("z/APP.md")
  })
})
