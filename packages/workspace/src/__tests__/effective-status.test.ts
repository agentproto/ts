import { describe, expect, it } from "vitest"
import { computeEffectiveStatus } from "../effective-status.js"
import type { WorkspaceStatus } from "../schema.js"

const STATUSES: WorkspaceStatus[] = ["active", "paused", "archived"]

describe("computeEffectiveStatus — no ancestors", () => {
  it("is the node's own status when there is no ancestor chain", () => {
    for (const status of STATUSES) {
      expect(computeEffectiveStatus(status, [])).toEqual({ effectiveStatus: status })
    }
  })

  it("defaults a missing own status to active, same as the schema default", () => {
    expect(computeEffectiveStatus(undefined, [])).toEqual({ effectiveStatus: "active" })
  })
})

describe("computeEffectiveStatus — single ancestor, every combination", () => {
  for (const own of STATUSES) {
    for (const parent of STATUSES) {
      it(`own=${own}, parent=${parent}`, () => {
        const result = computeEffectiveStatus(own, [{ id: "@t/parent", status: parent }])
        const expectRestrictive = (s: WorkspaceStatus) => ({ active: 0, paused: 1, archived: 2 })[s]
        if (expectRestrictive(parent) > expectRestrictive(own)) {
          expect(result).toEqual({ effectiveStatus: parent, statusInheritedFrom: "@t/parent" })
        } else {
          expect(result).toEqual({ effectiveStatus: own })
        }
      })
    }
  }

  it("treats a missing parent status as active (schema default)", () => {
    expect(computeEffectiveStatus("active", [{ id: "@t/parent", status: undefined }])).toEqual({
      effectiveStatus: "active",
    })
  })
})

describe("computeEffectiveStatus — deep chains", () => {
  it("picks the most restrictive ancestor across a 3-level chain", () => {
    const result = computeEffectiveStatus("active", [
      { id: "@t/parent", status: "active" },
      { id: "@t/grandparent", status: "paused" },
      { id: "@t/root", status: "active" },
    ])
    expect(result).toEqual({ effectiveStatus: "paused", statusInheritedFrom: "@t/grandparent" })
  })

  it("escalates to archived even when a nearer ancestor is merely paused", () => {
    const result = computeEffectiveStatus("active", [
      { id: "@t/parent", status: "paused" },
      { id: "@t/root", status: "archived" },
    ])
    expect(result).toEqual({ effectiveStatus: "archived", statusInheritedFrom: "@t/root" })
  })

  it("reports the NEARER of two equally-restrictive ancestors", () => {
    const result = computeEffectiveStatus("active", [
      { id: "@t/parent", status: "archived" },
      { id: "@t/root", status: "archived" },
    ])
    expect(result).toEqual({ effectiveStatus: "archived", statusInheritedFrom: "@t/parent" })
  })

  it("a node's own more-restrictive status is never overridden by a more active ancestor chain", () => {
    const result = computeEffectiveStatus("archived", [
      { id: "@t/parent", status: "active" },
      { id: "@t/root", status: "paused" },
    ])
    expect(result).toEqual({ effectiveStatus: "archived" })
  })

  it("an active child under a paused-then-active grandparent chain is simply reported, not an error", () => {
    // paused company under an active root; active project under the paused company.
    const result = computeEffectiveStatus("active", [
      { id: "@t/company", status: "paused" },
      { id: "@t/root", status: "active" },
    ])
    expect(result).toEqual({ effectiveStatus: "paused", statusInheritedFrom: "@t/company" })
  })

  it("missing status at every level (undefined) resolves to active throughout", () => {
    const result = computeEffectiveStatus(undefined, [
      { id: "@t/parent", status: undefined },
      { id: "@t/root", status: undefined },
    ])
    expect(result).toEqual({ effectiveStatus: "active" })
  })
})
