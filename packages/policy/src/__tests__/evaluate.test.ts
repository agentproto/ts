import { describe, expect, it } from "vitest"
import { combineDecisions, evaluateGrants, PolicyGrantError, type GrantDecision, type GrantRequest } from "../evaluate.js"
import type { Grant } from "../types.js"

const WHO = "operator://bob"

function grant(over: Partial<Grant> & { scope?: string; action?: string }): Grant {
  const { scope, action, ...rest } = over
  return {
    principal: WHO,
    actions: [{ action: action ?? "storage:commit", ...(scope !== undefined ? { scope } : {}) }],
    ...rest,
  }
}

function req(over: Partial<GrantRequest> = {}): GrantRequest {
  return { principals: [WHO], action: "storage:commit", ...over }
}

describe("evaluateGrants: composition (AIP-38 conformance 1, 2)", () => {
  it("allows a matching allow grant and defaults to deny otherwise", () => {
    expect(evaluateGrants([grant({})], req()).decision).toBe("allow")
    const none = evaluateGrants([], req())
    expect(none).toMatchObject({ decision: "deny", reason: "no-grant", via: "default" })
  })

  it("refuses a call a deny targets even when an allow matches it", () => {
    const allow = grant({})
    const deny = grant({ effect: "deny" })
    for (const order of [[allow, deny], [deny, allow]]) {
      expect(evaluateGrants(order, req())).toMatchObject({ decision: "deny", reason: "explicit-deny" })
    }
  })

  it("lets a deny in one composed policy beat an allow in another", () => {
    const allowing = { default: "deny" as const, grants: [grant({})] }
    const denying = { default: "deny" as const, grants: [grant({ effect: "deny" })] }
    expect(evaluateGrants([allowing, denying], req()).decision).toBe("deny")
    expect(evaluateGrants([denying, allowing], req()).decision).toBe("deny")
    expect(evaluateGrants([allowing], req()).decision).toBe("allow")
  })

  it("only applies a deny to the principal, action and scope it names", () => {
    const deny = grant({ effect: "deny", principal: "operator://eve" })
    expect(evaluateGrants([grant({}), deny], req()).decision).toBe("allow")
    const other = grant({ effect: "deny", action: "storage:delete-files" })
    expect(evaluateGrants([grant({}), other], req()).decision).toBe("allow")
  })

  it("lets default: deny prevail over a default: allow policy", () => {
    const open = { default: "allow" as const }
    const closed = { default: "deny" as const }
    expect(evaluateGrants([open], req()).decision).toBe("allow")
    expect(evaluateGrants([open, closed], req()).decision).toBe("deny")
    expect(evaluateGrants([open, {}], req()).decision).toBe("deny")
    expect(evaluateGrants([open, grant({})], req()).decision).toBe("allow")
  })

  it("lets a deny override default: allow", () => {
    const open = { default: "allow" as const, grants: [grant({ effect: "deny" })] }
    expect(evaluateGrants([open], req())).toMatchObject({ decision: "deny", reason: "explicit-deny" })
  })

  it("matches the wildcard principal and an exact action id, library form and prefix glob", () => {
    const star = grant({ principal: "*" })
    expect(evaluateGrants([star], req({ principals: ["operator://anyone"] })).decision).toBe("allow")
    expect(evaluateGrants([grant({ action: "@agentik/actions/standard/storage-commit" })], req()).decision).toBe("allow")
    expect(evaluateGrants([grant({ action: "storage:*" })], req()).decision).toBe("allow")
    expect(evaluateGrants([grant({ action: "model:*" })], req()).decision).toBe("deny")
  })
})

describe("evaluateGrants: principal forms", () => {
  it("matches a { ref } object principal by its ref", () => {
    const allow: Grant = { principal: { ref: WHO }, actions: [{ action: "storage:commit" }] }
    expect(evaluateGrants([allow], req()).decision).toBe("allow")
    const deny: Grant = { principal: { ref: "operator://eve" }, effect: "deny", actions: [{ action: "storage:commit" }] }
    expect(evaluateGrants([grant({}), deny], req()).decision).toBe("allow")
  })

  it("rejects { name, email } and { file } principals instead of denying every principal", () => {
    const unsupported: Grant[] = [
      { principal: { name: "Bob", email: "bob@example.com" }, effect: "deny", actions: [{ action: "storage:commit" }] },
      { principal: { file: "principals/bob.yaml" }, effect: "deny", actions: [{ action: "storage:commit" }] },
    ]
    for (const g of unsupported) {
      expect(() => evaluateGrants([grant({}), g], req())).toThrow(PolicyGrantError)
    }
  })
})

describe("evaluateGrants: revoke, ttl, conditions", () => {
  it("treats a revoked grant as no grant and reports explicit-revoke", () => {
    const revoked = grant({ revoked: true })
    expect(evaluateGrants([revoked], req())).toMatchObject({ decision: "deny", reason: "explicit-revoke" })
  })

  it("does not apply a revoked deny", () => {
    expect(evaluateGrants([grant({}), grant({ effect: "deny", revoked: true })], req()).decision).toBe("allow")
  })

  it("applies a revocation on the next evaluation of the same grants", () => {
    const g = grant({})
    expect(evaluateGrants([g], req()).decision).toBe("allow")
    expect(evaluateGrants([{ ...g, revoked: true }], req()).decision).toBe("deny")
  })

  it("expires a ttl grant at granted_at + ttl_seconds, and treats a missing granted_at as expired", () => {
    const g = grant({ ttl_seconds: 60, granted_at: "2026-10-29T00:00:00Z" })
    const t0 = Date.parse("2026-10-29T00:00:00Z")
    expect(evaluateGrants([g], req({ now: t0 + 59_000 })).decision).toBe("allow")
    expect(evaluateGrants([g], req({ now: t0 + 60_000 }))).toMatchObject({ decision: "deny", reason: "ttl-expired" })
    expect(evaluateGrants([grant({ ttl_seconds: 60 })], req({ now: t0 })).reason).toBe("ttl-expired")
  })

  it("does not apply an expired deny", () => {
    const d = grant({ effect: "deny", ttl_seconds: 10, granted_at: "2026-10-29T00:00:00Z" })
    const later = Date.parse("2026-10-29T01:00:00Z")
    expect(evaluateGrants([grant({}), d], req({ now: later })).decision).toBe("allow")
  })

  it("ANDs conditions, and an unknown condition leaves an allow unsatisfied with a warning", () => {
    const g = grant({ conditions: [{ kind: "mfa-recent" }, { kind: "ip-range" }] })
    const known = (c: { kind: string }) => (c.kind === "mfa-recent" ? true : undefined)
    const out = evaluateGrants([g], req({ evaluateCondition: known }))
    expect(out).toMatchObject({ decision: "deny", reason: "condition-failed" })
    expect(out.warnings.join(" ")).toContain("ip-range")
    expect(evaluateGrants([g], req({ evaluateCondition: () => true })).decision).toBe("allow")
    expect(evaluateGrants([g], req({ evaluateCondition: () => false })).decision).toBe("deny")
  })

  it("applies a deny whose condition is unknown (fails closed) and skips one whose condition is false", () => {
    const d = grant({ effect: "deny", conditions: [{ kind: "custom" }] })
    expect(evaluateGrants([grant({}), d], req()).decision).toBe("deny")
    expect(evaluateGrants([grant({}), d], req({ evaluateCondition: () => false })).decision).toBe("allow")
    expect(evaluateGrants([grant({}), d], req({ evaluateCondition: () => true })).decision).toBe("deny")
  })
})

describe("evaluateGrants: scope matching (AIP-38 rules 1, 2, 5)", () => {
  it("rule 5: a grant without scope matches every scope", () => {
    expect(evaluateGrants([grant({})], req({ scope: "anything" })).decision).toBe("allow")
    expect(evaluateGrants([grant({})], req()).decision).toBe("allow")
  })

  it("rule 1: an exact scope matches only the same string, case-sensitively", () => {
    const g = grant({ scope: "pygmalion/cron_create" })
    expect(evaluateGrants([g], req({ scope: "pygmalion/cron_create" })).decision).toBe("allow")
    expect(evaluateGrants([g], req({ scope: "pygmalion/Cron_create" })).decision).toBe("deny")
    expect(evaluateGrants([g], req()).decision).toBe("deny")
  })

  it("rule 2: a trailing * is a prefix glob, a lone * matches all, a * elsewhere is literal", () => {
    expect(evaluateGrants([grant({ scope: "a/*" })], req({ scope: "a/x" })).decision).toBe("allow")
    expect(evaluateGrants([grant({ scope: "a/*" })], req({ scope: "b/x" })).decision).toBe("deny")
    expect(evaluateGrants([grant({ scope: "*" })], req({ scope: "b/x" })).decision).toBe("allow")
    expect(evaluateGrants([grant({ scope: "a/*/z" })], req({ scope: "a/x/z" })).decision).toBe("deny")
    expect(evaluateGrants([grant({ scope: "a/*/z" })], req({ scope: "a/*/z" })).decision).toBe("allow")
  })

  it("a deny scoped to one target does not refuse another", () => {
    const d = grant({ effect: "deny", scope: "s1" })
    expect(evaluateGrants([grant({}), d], req({ scope: "s1" })).decision).toBe("deny")
    expect(evaluateGrants([grant({}), d], req({ scope: "s2" })).decision).toBe("allow")
  })
})

describe("evaluateGrants: unresolvable scopes fail closed (rule 4)", () => {
  const sel = "selector:frontier-models"

  it("evaluates an allow with an unresolvable selector as not matching", () => {
    expect(evaluateGrants([grant({ scope: sel })], req({ scope: "m1" })).decision).toBe("deny")
  })

  it("evaluates a deny with an unresolvable selector as matching", () => {
    const out = evaluateGrants([grant({}), grant({ effect: "deny", scope: sel })], req({ scope: "m1" }))
    expect(out).toMatchObject({ decision: "deny", reason: "explicit-deny" })
  })

  it("treats a resolver that returns undefined as unresolvable", () => {
    const resolveSelector = () => undefined
    expect(evaluateGrants([grant({ scope: sel })], req({ scope: "m1", resolveSelector })).decision).toBe("deny")
    expect(
      evaluateGrants([grant({}), grant({ effect: "deny", scope: sel })], req({ scope: "m1", resolveSelector })).decision,
    ).toBe("deny")
  })

  it("matches by membership once the selector resolves", () => {
    const resolveSelector = (id: string) => (id === "frontier-models" ? ["m1", "m2"] : undefined)
    const allow = grant({ scope: sel })
    expect(evaluateGrants([allow], req({ scope: "m1", resolveSelector })).decision).toBe("allow")
    expect(evaluateGrants([allow], req({ scope: "m9", resolveSelector })).decision).toBe("deny")
    const deny = grant({ effect: "deny", scope: sel })
    expect(evaluateGrants([grant({}), deny], req({ scope: "m9", resolveSelector })).decision).toBe("allow")
    expect(evaluateGrants([grant({}), deny], req({ scope: "m2", resolveSelector })).decision).toBe("deny")
  })

  it("fails closed on a typed scope the host declares but cannot resolve", () => {
    const typed = { label: undefined }
    expect(evaluateGrants([grant({ scope: "label:ops" })], req({ typed })).decision).toBe("deny")
    expect(evaluateGrants([grant({}), grant({ effect: "deny", scope: "label:ops" })], req({ typed })).decision).toBe("deny")
  })

  it("matches typed label and workspace forms by value or prefix; an empty prefix matches nothing", () => {
    const typed = { label: "ops-1", workspace: null }
    const allow = (scope: string) => evaluateGrants([grant({ scope })], req({ typed })).decision
    expect(allow("label:ops-1")).toBe("allow")
    expect(allow("label:ops-*")).toBe("allow")
    expect(allow("label:*")).toBe("deny")
    expect(allow("label:other")).toBe("deny")
    expect(allow("workspace:w")).toBe("deny")
  })

  it("reads a typed-looking scope as a plain name when the action declares no such form", () => {
    expect(evaluateGrants([grant({ scope: "label:ops" })], req({ scope: "label:ops" })).decision).toBe("allow")
  })
})

describe("combineDecisions: deterministic deny precedence", () => {
  function decision(reason: GrantDecision["reason"]): GrantDecision {
    return { decision: "deny", reason, via: "default", warnings: [] }
  }

  it("prefers a more specific deny reason over no-grant regardless of order", () => {
    expect(combineDecisions([decision("no-grant"), decision("ttl-expired")]).reason).toBe("ttl-expired")
    expect(combineDecisions([decision("ttl-expired"), decision("no-grant")]).reason).toBe("ttl-expired")
    expect(combineDecisions([decision("no-grant"), decision("condition-failed")]).reason).toBe("condition-failed")
    expect(combineDecisions([decision("ttl-expired"), decision("explicit-revoke")]).reason).toBe("explicit-revoke")
  })
})

describe("evaluateGrants: malformed input", () => {
  it("throws a typed error rather than guessing", () => {
    const bad = [
      { principal: WHO, actions: [] },
      { principal: WHO, actions: [{ scope: "x" }] },
      { principal: WHO, effect: "maybe", actions: [{ action: "a:b" }] },
      { actions: [{ action: "a:b" }] },
    ] as unknown as Grant[]
    for (const g of bad) {
      expect(() => evaluateGrants([g], req())).toThrow(PolicyGrantError)
    }
  })

  it("does not mutate its input", () => {
    const grants = Object.freeze([Object.freeze(grant({ effect: "deny" }))])
    expect(() => evaluateGrants(grants, req())).not.toThrow()
  })
})
