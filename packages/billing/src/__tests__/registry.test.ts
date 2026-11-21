import { describe, expect, it } from "vitest"
import { makeBillingRegistry } from "../registry.js"

describe("makeBillingRegistry", () => {
  it("leaves a slug outside the catalog unresolved without touching the import seam (no ctx.entry)", async () => {
    const imports: string[] = []
    const reg = makeBillingRegistry({
      importPackage: async name => {
        imports.push(name)
        throw new Error(`unexpected import of ${name}`)
      },
    })
    expect(await reg.provider("not-a-catalog-slug")).toBeNull()
    expect(imports).toEqual([])
    expect((await reg.family.list()).map(e => e.slug)).not.toContain("not-a-catalog-slug")
  })
})
