import { describe, expect, it } from "vitest"
import { loadFooterOwnerOrgs } from "../pr-provenance-skip.js"

describe("loadFooterOwnerOrgs", () => {
  it("passes a configured list through, dropping non-strings", async () => {
    const owners = await loadFooterOwnerOrgs(async () => ({
      defaults: { prProvenance: { footer: { ownerOrgs: ["acme", 3 as unknown as string] } } },
    }))
    expect(owners).toEqual(["acme"])
  })
  it("yields none when unset, malformed or unreadable", async () => {
    expect(await loadFooterOwnerOrgs(async () => ({}))).toEqual([])
    expect(
      await loadFooterOwnerOrgs(async () => ({
        defaults: { prProvenance: { footer: { ownerOrgs: "acme" as unknown as string[] } } },
      })),
    ).toEqual([])
    expect(await loadFooterOwnerOrgs(async () => { throw new Error("boom") })).toEqual([])
  })
})
