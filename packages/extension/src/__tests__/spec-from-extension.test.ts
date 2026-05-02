import { describe, it, expect } from "vitest"
import type { DoctypeSpec } from "@agentproto/manifest"
import { defineExtension } from "../define-extension.js"
import { specFromExtension } from "../spec-from-extension.js"

interface FakeParams {
  id: string
  description: string
  approval?: string
  cost_class?: string
}
interface FakeHandle extends FakeParams {
  readonly id: string
  readonly description: string
  readonly approval: string
  readonly cost_class: string
}

const parentSpec: DoctypeSpec<FakeParams, FakeHandle> = {
  name: "tool",
  aip: 14,
  schemaLiteral: "agentproto/tool/v1",
  pathOf: (h) => `${h.id}/TOOL.md`,
  define: (params) =>
    Object.freeze({
      id: params.id,
      description: params.description,
      approval: params.approval ?? "auto",
      cost_class: params.cost_class ?? "trivial",
    }),
  parse: () => ({ frontmatter: {}, body: "" }),
}

const acmeDealExt = defineExtension({
  schema: "agentproto/extension/v1",
  slug: "acme:deal",
  title: "ACME deal manifest",
  description: "Workspace-local TOOL.md variant with billing fields.",
  version: "1.0.0",
  status: "Local",
  extends: "aip-14",
  add_fields: {
    properties: {
      customer_id: { type: "string", minLength: 1 },
      amount: { type: "number", minimum: 0 },
    },
    required: ["customer_id", "amount"],
  },
  defaults: {
    approval: "on-mutate",
    cost_class: "metered",
  },
  path_convention: "deals/<slug>/DEAL.md",
})

describe("specFromExtension — composes parent + extension into a runtime spec", () => {
  it("inherits parent's define, applies extension defaults", () => {
    const spec = specFromExtension(acmeDealExt, { parent: parentSpec })
    const handle = spec.define({
      id: "ord-42",
      description: "Q2 deal with ACME West",
    } as never)
    // Extension's defaults applied (parent would have used 'auto' / 'trivial').
    expect((handle as FakeHandle).approval).toBe("on-mutate")
    expect((handle as FakeHandle).cost_class).toBe("metered")
  })

  it("overrides path convention", () => {
    const spec = specFromExtension(acmeDealExt, { parent: parentSpec })
    const path = spec.pathOf({ id: "ord-42" } as never)
    expect(path).toBe("deals/ord-42/DEAL.md")
  })

  it("expands <DOCTYPE> token from the slug name part", () => {
    const ext = defineExtension({
      ...acmeDealExt,
      path_convention: "<slug>/<DOCTYPE>.md",
    })
    const spec = specFromExtension(ext, { parent: parentSpec })
    expect(spec.pathOf({ id: "ord-42" } as never)).toBe("ord-42/DEAL.md")
  })

  it("falls through to parent's pathOf when extension has none", () => {
    const ext = defineExtension({
      ...acmeDealExt,
      path_convention: undefined,
    } as never)
    const spec = specFromExtension(ext, { parent: parentSpec })
    expect(spec.pathOf({ id: "ord-42" } as never)).toBe("ord-42/TOOL.md")
  })

  it("rejects extends-pointing extensions without a parent", () => {
    expect(() =>
      specFromExtension(acmeDealExt /* no opts.parent */),
    ).toThrow(/extends 'aip-14' but no parent spec/)
  })

  it("requires path_convention when extends: none", () => {
    const rootExt = defineExtension({
      ...acmeDealExt,
      slug: "acme:standalone",
      extends: "none",
      path_convention: undefined,
    } as never)
    expect(() => specFromExtension(rootExt)).toThrow(
      /root doctype \(extends: none\) and MUST declare path_convention/,
    )
  })

  it("rejects tighten with minLength > maxLength", () => {
    const badExt = defineExtension({
      ...acmeDealExt,
      slug: "acme:bad",
      tighten: {
        id: { minLength: 10, maxLength: 4 },
      },
    })
    expect(() =>
      specFromExtension(badExt, { parent: parentSpec }),
    ).toThrow(/minLength.*> maxLength/)
  })
})
