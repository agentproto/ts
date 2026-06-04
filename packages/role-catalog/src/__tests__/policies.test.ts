import { describe, it, expect } from "vitest"
import {
  BUILTIN_POLICY_HANDLES,
  talentAcquisitionBaselinePolicy,
  BUILTIN_ROLE_ENTRIES,
} from "../index.js"

describe("@agentproto/role-catalog baseline policies", () => {
  it("ships the talent-acquisition baseline policy", () => {
    expect(BUILTIN_POLICY_HANDLES).toContain(talentAcquisitionBaselinePolicy)
  })

  it("defaults to deny (operator may only do what is granted)", () => {
    expect(talentAcquisitionBaselinePolicy.default).toBe("deny")
  })

  it("grants the recruiting actions to the role principal", () => {
    const grant = talentAcquisitionBaselinePolicy.grants?.[0]
    expect(grant?.principal).toBe("role://talent-acquisition-specialist")
    const actions = grant?.actions.map(a => a.action) ?? []
    expect(actions).toContain("sourcing:*")
    expect(actions).toContain("screening:*")
    // hire-decision actions are NOT granted — they go through approval
    expect(actions).not.toContain("hiring:extend-offer")
  })

  it("requires human approval for hire-decision actions", () => {
    const req = talentAcquisitionBaselinePolicy.requirements?.find(
      r => r.kind === "approval-from"
    )
    expect(req?.applies_to).toEqual([
      "hiring:extend-offer",
      "hiring:reject-candidate",
    ])
  })

  it("the recruiter role advertises this policy as its defaultPolicy", () => {
    const role = BUILTIN_ROLE_ENTRIES.find(
      e => e.slug === "talent-acquisition-specialist"
    )
    expect(role?.handle.defaultPolicy).toBe("@builtin/talent-acquisition-baseline")
  })
})
