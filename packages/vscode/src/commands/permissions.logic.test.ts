import { describe, expect, it } from "vitest"

import { extractPermissionId, selectApprovalOption } from "./permissions.logic.js"

describe("selectApprovalOption", () => {
  it("returns none when there are no options", () => {
    expect(selectApprovalOption([])).toEqual({ kind: "none" })
    expect(selectApprovalOption(undefined)).toEqual({ kind: "none" })
  })

  it("picks the single allow-flavored option", () => {
    const options = [
      { optionId: "reject_once", kind: "reject_once" },
      { optionId: "allow_once", kind: "allow_once" },
    ]
    expect(selectApprovalOption(options)).toEqual({ kind: "single", optionId: "allow_once" })
  })

  it("is ambiguous when multiple allow-flavored options are offered", () => {
    const options = [
      { optionId: "allow_once", kind: "allow_once" },
      { optionId: "allow_always", kind: "allow_always" },
    ]
    const result = selectApprovalOption(options)
    expect(result.kind).toBe("ambiguous")
    expect(result).toMatchObject({
      candidates: [
        { optionId: "allow_once", kind: "allow_once" },
        { optionId: "allow_always", kind: "allow_always" },
      ],
    })
  })

  it("falls back to the lone option when none is kind-tagged allow_", () => {
    const options = [{ optionId: "only-option" }]
    expect(selectApprovalOption(options)).toEqual({ kind: "single", optionId: "only-option" })
  })

  it("is ambiguous when multiple options exist with no allow_ kind", () => {
    const options = [{ optionId: "a" }, { optionId: "b" }]
    const result = selectApprovalOption(options)
    expect(result.kind).toBe("ambiguous")
    expect(result).toMatchObject({ candidates: [{ optionId: "a" }, { optionId: "b" }] })
  })
})

describe("extractPermissionId", () => {
  it("passes through a bare string id (toast button payload)", () => {
    expect(extractPermissionId("p1")).toBe("p1")
  })

  it("reads permissionId off a tree-item-shaped object", () => {
    expect(extractPermissionId({ permissionId: "p2", label: "Bash" })).toBe("p2")
  })

  it("returns undefined for undefined/empty/garbage", () => {
    expect(extractPermissionId(undefined)).toBeUndefined()
    expect(extractPermissionId("")).toBeUndefined()
    expect(extractPermissionId({})).toBeUndefined()
    expect(extractPermissionId(42)).toBeUndefined()
  })
})
