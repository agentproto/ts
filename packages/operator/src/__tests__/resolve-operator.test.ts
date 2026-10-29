import { readFileSync, readdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it, vi } from "vitest"
import type { AgentEntry } from "@agentproto/agent"
import { evaluateToolInvoke } from "@agentproto/policy"
import type { PolicyGrants } from "@agentproto/policy"
import type { RoleManifestRaw, RoleSource } from "@agentproto/role"
import { defineOperator } from "../define-operator.js"
import {
  OperatorResolutionError,
  resolveOperator,
  toolDenyGrants,
  type OperatorSources,
} from "../index.js"

type Def = Parameters<typeof defineOperator>[0]

const operatorOf = (over: Partial<Def> = {}) =>
  defineOperator({
    id: "ops-lee",
    name: "Lee",
    persona_summary: "Runs the desk.",
    model: "test/model",
    role: "analyst",
    policy: { inline: { default: "deny", grants: [] } },
    ...over,
  } as Def)

function grant(scope: string, effect?: "deny"): NonNullable<PolicyGrants["grants"]>[number] {
  return {
    principal: "*",
    ...(effect ? { effect } : {}),
    actions: [{ action: "tool:invoke", scope }],
  }
}

const policyOf = (...scopes: (string | [string, "deny"])[]): PolicyGrants => ({
  default: "deny",
  grants: scopes.map(s => (Array.isArray(s) ? grant(s[0], s[1]) : grant(s))),
})

function roleManifest(
  name: string,
  extra: Record<string, unknown> = {},
  body = `ROLEBODY-${name}`,
): RoleManifestRaw {
  return {
    ref: name,
    scheme: "memory",
    body,
    frontmatter: {
      schema: "role/v1",
      name,
      title: `Title ${name}`,
      description: `Description of ${name}.`,
      version: "1.0.0",
      seniority: "mid",
      mission: `MISSION-${name}`,
      responsibilities: [`RESP-${name}`],
      ...extra,
    },
  }
}

function roleSource(manifests: RoleManifestRaw[]): RoleSource {
  const byRef = new Map(manifests.map(m => [m.ref, m]))
  return { scheme: "memory", load: async ref => byRef.get(ref) ?? null }
}

const base = (over: Partial<OperatorSources> = {}): OperatorSources => ({
  roles: [roleSource([roleManifest("analyst")])],
  ...over,
})

const agentEntry = (id: string, over: Record<string, unknown> = {}, body?: string): AgentEntry => ({
  agent: { schema: "agent/v1", id, description: `Agent ${id}.`, model: "test/model", ...over } as AgentEntry["agent"],
  ...(body !== undefined ? { body } : {}),
})

const refusal = async (p: Promise<unknown>): Promise<OperatorResolutionError> => {
  try {
    await p
  } catch (e) {
    expect(e).toBeInstanceOf(OperatorResolutionError)
    return e as OperatorResolutionError
  }
  throw new Error("expected resolveOperator to refuse")
}

describe("tools are filtered by the operator's AIP-38 policy", () => {
  it("refuses a tool the operator declares when its policy grants no tool:invoke for it", async () => {
    const operator = operatorOf({
      tools: ["srv/read", "srv/write"],
      policy: { inline: policyOf("srv/read") as never },
    })
    const err = await refusal(resolveOperator({ operator }, base()))
    expect(err.code).toBe("tool_not_granted")
    expect(err.issues.map(i => i.subject)).toEqual(["srv/write"])
  })

  it("refuses a tool a base agent or a role slot declares, not only the operator's own", async () => {
    const roles = [roleManifest("analyst", { slots: { feed: { tool: "mcp" } } })]
    const operator = operatorOf({
      extends: "base",
      role: { ref: "analyst", bind: { feed: { kind: "mcp", server: "news", allow: ["latest"] } } },
      policy: { inline: policyOf("srv/read") as never },
    })
    const err = await refusal(
      resolveOperator(
        { operator },
        base({
          roles: [roleSource(roles)],
          agent: async () => agentEntry("base", { tools: ["srv/secret"] }),
        }),
      ),
    )
    expect(err.issues.map(i => i.subject).sort()).toEqual(["news/latest", "srv/secret"])
  })

  it("refuses every declared tool when the operator has no policy at all", async () => {
    const operator = operatorOf({ tools: ["srv/read"], policy: undefined })
    const err = await refusal(resolveOperator({ operator }, base()))
    expect(err.code).toBe("tool_not_granted")
  })

  it("keeps a granted tool, qualifies a bare built-in name and unions all four origins", async () => {
    const roles = [
      roleManifest("analyst", { tools: ["srv/intent"], slots: { feed: { tool: "ref" } } }),
    ]
    const operator = operatorOf({
      extends: "base",
      tools: ["own_tool"],
      role: { ref: "analyst", bind: { feed: "tool:srv/slot" } },
      policy: { inline: policyOf("srv/*", "agentproto/*") as never },
    })
    const out = await resolveOperator(
      { operator },
      base({
        roles: [roleSource(roles)],
        agent: async () => agentEntry("base", { tools: ["srv/agent"] }),
      }),
    )
    expect(out.agent.tools).toEqual(["srv/agent", "srv/slot", "agentproto/own_tool", "srv/intent"])
  })

  it("lets a chain policy deny win over the operator's own allow", async () => {
    const operator = operatorOf({ tools: ["srv/read"], policy: { inline: policyOf("srv/*") as never } })
    const err = await refusal(
      resolveOperator({ operator }, base({ chainPolicies: [policyOf(["srv/read", "deny"])] })),
    )
    expect(err.issues.map(i => i.subject)).toEqual(["srv/read"])
  })

  it("honours an mcp item's deny entry and offers only the granted allow names", async () => {
    const operator = operatorOf({
      tools: [{ kind: "mcp", server: "srv", allow: ["a", "b"], deny: ["b"] }],
      policy: { inline: policyOf("srv/a", "srv/b") as never },
    })
    const out = await resolveOperator({ operator }, base())
    expect(out.agent.tools).toEqual([{ kind: "mcp", server: "srv", allow: ["a"], deny: ["b"] }])
  })

  it("drops a tool only the role intends, with an intent_unsatisfied warning, and still resolves", async () => {
    const roles = [roleManifest("analyst", { tools: ["srv/granted", "srv/ungranted"] })]
    const operator = operatorOf({ policy: { inline: policyOf("srv/granted") as never } })
    const out = await resolveOperator({ operator }, base({ roles: [roleSource(roles)] }))
    expect(out.agent.tools).toEqual(["srv/granted"])
    const warning = out.warnings.find(w => w.code === "intent_unsatisfied")
    expect(warning?.subject).toBe("srv/ungranted")
    expect(out.warnings.filter(w => w.code === "intent_unsatisfied")).toHaveLength(1)
  })

  it("refuses a malformed effective policy rather than treating it as empty", async () => {
    const operator = operatorOf({ tools: ["srv/read"], policy: { inline: { grants: [{ actions: [] }] } as never } })
    const err = await refusal(resolveOperator({ operator }, base()))
    expect(err.code).toBe("policy_invalid")
  })
})

describe("toolDenyGrants", () => {
  it("turns an mcp item's deny entries into tool:invoke deny grants the engine enforces", () => {
    const grants = toolDenyGrants([
      "srv/plain",
      { kind: "mcp", server: "srv", allow: ["a", "b"], deny: ["b"] },
      { kind: "mcp", server: "other" },
    ])
    expect(grants).toHaveLength(1)
    const allowAll = { default: "allow" as const, grants: [] }
    const call = (tool: string) => evaluateToolInvoke([allowAll, ...grants], { principals: ["operator://x"], tool }).decision
    expect(call("srv/b")).toBe("deny")
    expect(call("srv/a")).toBe("allow")
    expect(call("other/b")).toBe("allow")
  })
})

describe("the body follows the AIP-9 merge table", () => {
  it("orders agent, identity, persona, role, bindings, operator, host sections, then boundaries", async () => {
    const roles = [
      roleManifest("analyst", { slots: { region: { scalar: "string", description: "Region" } }, antiPatterns: ["ANTI-role"] }),
    ]
    const operator = operatorOf({
      extends: "base",
      identity: "id-ref",
      persona: "persona-ref",
      role: { ref: "analyst", with: { region: "BINDING-emea" } },
      boundaries: ["BOUND-operator"],
    })
    const out = await resolveOperator(
      { operator, body: "OPERATOR-BODY" },
      base({
        roles: [roleSource(roles)],
        agent: async () => agentEntry("base", { boundaries: ["BOUND-agent"] }, "AGENT-BODY"),
        identity: async () => ({
          identity: { schema: "identity.workspace/v1", name: "i", title: "IDENTITY-TITLE", description: "d", version: "1" } as never,
        }),
        persona: async () => ({
          persona: {
            schema: "persona/v1",
            name: "p",
            title: "PERSONA-TITLE",
            description: "d",
            version: "1",
            boundaries: { refuses: ["BOUND-persona"] },
          } as never,
        }),
        hostSections: ["HOST-SECTION"],
      }),
    )
    const marks = [
      "AGENT-BODY",
      "IDENTITY-TITLE",
      "PERSONA-TITLE",
      "MISSION-analyst",
      "ROLEBODY-analyst",
      "BINDING-emea",
      "OPERATOR-BODY",
      "HOST-SECTION",
      "BOUND-agent",
    ].map(m => out.body.indexOf(m))
    expect(marks.every(i => i >= 0)).toBe(true)
    expect([...marks].sort((a, b) => a - b)).toEqual(marks)
    for (const b of ["BOUND-agent", "BOUND-persona", "BOUND-operator", "ANTI-role"]) {
      expect(out.body.indexOf(b)).toBeGreaterThan(marks[7]!)
      expect(out.agent.boundaries?.some(x => x.includes(b))).toBe(true)
    }
  })

  it("renders two operators sharing one role with different slot bindings into different prompts", async () => {
    const roles = [
      roleManifest("analyst", {
        slots: { region: { scalar: "string", description: "Region" }, wiki: { collection: "wikis", description: "House wiki" } },
      }),
    ]
    const sources = base({ roles: [roleSource(roles)] })
    const emea = await resolveOperator(
      { operator: operatorOf({ id: "lee-emea", role: { ref: "analyst", bind: { wiki: "ws://wikis/emea-wiki" }, with: { region: "EMEA" } } }) },
      sources,
    )
    const apac = await resolveOperator(
      { operator: operatorOf({ id: "lee-apac", role: { ref: "analyst", bind: { wiki: "ws://wikis/apac-wiki" }, with: { region: "APAC" } } }) },
      sources,
    )
    expect(emea.body).toContain("region (Region): EMEA")
    expect(emea.body).toContain("wiki (House wiki): ws://wikis/emea-wiki")
    expect(emea.body).not.toContain("APAC")
    expect(apac.body).toContain("region (Region): APAC")
    expect(apac.body).toContain("wiki (House wiki): ws://wikis/apac-wiki")
    expect(apac.body).not.toContain("EMEA")
    expect(emea.body).not.toBe(apac.body)
    expect(emea.digest).not.toBe(apac.digest)
  })

  it("surfaces the role's knowledge packs and anchors memory on the operator", async () => {
    const roles = [roleManifest("analyst", { knowledge: { packs: ["pack-a"] } })]
    const out = await resolveOperator({ operator: operatorOf() }, base({ roles: [roleSource(roles)] }))
    expect(out.knowledgePacks).toEqual(["pack-a"])
    expect(out.agent.memory?.anchors).toEqual(["operator:ops-lee"])
  })

  it("inlines the role's skill bodies after the role body", async () => {
    const roles = [roleManifest("analyst", { skills: ["ws://skills/triage"] })]
    const out = await resolveOperator(
      { operator: operatorOf() },
      base({
        roles: [roleSource(roles)],
        skill: async ref => ({ skill: { name: ref } as never, body: "SKILL-BODY" }),
      }),
    )
    expect(out.body.indexOf("SKILL-BODY")).toBeGreaterThan(out.body.indexOf("ROLEBODY-analyst"))
  })
})

describe("a role binding the role rejects refuses resolution", () => {
  const roles = [
    roleManifest("analyst", { slots: { region: { scalar: "string" }, wiki: { collection: "wikis", optional: true } } }),
  ]
  const run = (role: Def["role"]) =>
    refusal(resolveOperator({ operator: operatorOf({ role }) }, base({ roles: [roleSource(roles)] })))

  it("refuses an unbound required slot", async () => {
    const err = await run({ ref: "analyst" })
    expect(err.code).toBe("role_binding_invalid")
    expect(err.issues[0]?.message).toContain("role_slot_unbound")
  })

  it("refuses a slot the role does not declare", async () => {
    const err = await run({ ref: "analyst", with: { region: "x" }, bind: { nope: "ws://wikis/x" } })
    expect(err.issues[0]?.message).toContain("role_slot_unknown")
  })

  it("refuses a value of the wrong type", async () => {
    const err = await run({ ref: "analyst", with: { region: 3 }, bind: {} })
    expect(err.issues[0]?.message).toContain("role_slot_type_mismatch")
  })

  it("passes a role_slot_unresolvable warning through without refusing", async () => {
    const out = await resolveOperator(
      { operator: operatorOf({ role: { ref: "analyst", with: { region: "x" }, bind: { wiki: "ws://wikis/gone" } } }) },
      base({ roles: [roleSource(roles)], refResolves: () => false }),
    )
    expect(out.warnings.map(w => w.code)).toContain("role_slot_unresolvable")
  })
})

describe("chains and unresolvable references", () => {
  const chainOfRoles = (n: number) =>
    Array.from({ length: n }, (_, i) =>
      roleManifest(`r${i}`, i < n - 1 ? { extends: `r${i + 1}` } : {}),
    )

  it("accepts a role chain of 8 and refuses 9", async () => {
    const ok = await resolveOperator(
      { operator: operatorOf({ role: "r0" }) },
      base({ roles: [roleSource(chainOfRoles(8))] }),
    )
    expect(ok.roleChain).toHaveLength(8)
    const err = await refusal(
      resolveOperator({ operator: operatorOf({ role: "r0" }) }, base({ roles: [roleSource(chainOfRoles(9))] })),
    )
    expect(err.code).toBe("role_chain_too_deep")
  })

  it("refuses a role extends cycle", async () => {
    const cyc = [roleManifest("a", { extends: "b" }), roleManifest("b", { extends: "a" })]
    const err = await refusal(
      resolveOperator({ operator: operatorOf({ role: "a" }) }, base({ roles: [roleSource(cyc)] })),
    )
    expect(err.code).toBe("role_chain_cycle")
  })

  it("refuses a role no source returns", async () => {
    const err = await refusal(resolveOperator({ operator: operatorOf({ role: "ghost" }) }, base()))
    expect(err.code).toBe("role_unresolvable")
  })

  const agentChain = (n: number) => async (ref: string): Promise<AgentEntry | null> => {
    const i = Number(ref.slice(1))
    return i > n ? null : agentEntry(`a${i}`, i < n ? { extends: `a${i + 1}` } : {})
  }

  it("accepts an agent chain of 5 parents and refuses 6", async () => {
    const ok = await resolveOperator({ operator: operatorOf({ extends: "a1" }) }, base({ agent: agentChain(5) }))
    expect(ok.agentChain).toEqual(["ops-lee", "a1", "a2", "a3", "a4", "a5"])
    const err = await refusal(
      resolveOperator({ operator: operatorOf({ extends: "a1" }) }, base({ agent: agentChain(6) })),
    )
    expect(err.code).toBe("agent_chain_too_deep")
  })

  it("refuses an agent extends cycle", async () => {
    const err = await refusal(
      resolveOperator(
        { operator: operatorOf({ extends: "x" }) },
        base({
          agent: async ref =>
            ref === "x" ? agentEntry("x", { extends: "y" }) : ref === "y" ? agentEntry("y", { extends: "x" }) : null,
        }),
      ),
    )
    expect(err.code).toBe("agent_chain_cycle")
  })

  it.each([
    ["agent", { extends: "gone" }, "agent_unresolvable"],
    ["identity", { identity: "gone" }, "identity_unresolvable"],
    ["persona", { persona: "gone" }, "persona_unresolvable"],
    ["policy", { policy: "gone" }, "policy_unresolvable"],
  ] as const)("refuses a %s ref the loader does not return, and one with no loader at all", async (_k, over, code) => {
    const operator = operatorOf(over as Partial<Def>)
    expect((await refusal(resolveOperator({ operator }, base({ [_k]: async () => null })))).code).toBe(code)
    expect((await refusal(resolveOperator({ operator }, base()))).code).toBe(code)
  })

  it("refuses a proactive operator whose autonomy 0 is inherited from a base agent", async () => {
    const operator = operatorOf({ extends: "gated", participation: { mode: "proactive" } })
    const sources = base({ agent: async () => agentEntry("gated", { autonomy: 0 }) })
    expect((await refusal(resolveOperator({ operator }, sources))).code).toBe("autonomy_participation_conflict")
  })

  it("refuses when no model resolves and the host supplies no default", async () => {
    const operator = operatorOf({ model: undefined })
    expect((await refusal(resolveOperator({ operator }, base()))).code).toBe("model_missing")
    const out = await resolveOperator({ operator }, base({ defaultModel: "host/default" }))
    expect(out.agent.model).toBe("host/default")
  })
})

describe("the digest", () => {
  const roles = (body: string) => [
    roleManifest("analyst", { slots: { region: { scalar: "string" }, wiki: { collection: "wikis", optional: true } } }, body),
  ]
  const fixture = (o: {
    roleBody?: string
    region?: string
    wiki?: string
    persona?: string
    identity?: string
    policy?: PolicyGrants
    chain?: PolicyGrants[]
    opBody?: string
    host?: string[]
    extra?: Partial<Def>
  } = {}) =>
    resolveOperator(
      {
        operator: operatorOf({
          persona: "p",
          identity: "i",
          policy: { inline: (o.policy ?? policyOf("srv/read")) as never },
          role: { ref: "analyst", with: { region: o.region ?? "EMEA" }, bind: { wiki: o.wiki ?? "ws://wikis/w1" } },
          ...o.extra,
        }),
        body: o.opBody ?? "op body",
      },
      base({
        roles: [roleSource(roles(o.roleBody ?? "role body"))],
        persona: async () => ({ persona: { name: "p", title: o.persona ?? "persona v1" } as never }),
        identity: async () => ({ identity: { name: "i", title: o.identity ?? "identity v1" } as never }),
        chainPolicies: o.chain ?? [],
        hostSections: o.host ?? [],
      }),
    ).then(r => r.digest)

  it("is stable for identical inputs", async () => {
    const [a, b] = await Promise.all([fixture(), fixture()])
    expect(a).toBe(b)
    expect(a).toMatch(/^[0-9a-f]{64}$/)
  })

  it("does not depend on key order", async () => {
    const reordered = { grants: policyOf("srv/read").grants, default: "deny" as const }
    expect(await fixture({ policy: reordered })).toBe(await fixture())
  })

  it.each([
    ["role body", { roleBody: "role body v2" }],
    ["slot scalar binding", { region: "APAC" }],
    ["slot ref binding", { wiki: "ws://wikis/w2" }],
    ["persona", { persona: "persona v2" }],
    ["identity", { identity: "identity v2" }],
    ["policy", { policy: policyOf("srv/read", "srv/more") }],
    ["chain policy", { chain: [policyOf(["srv/other", "deny"])] }],
    ["operator body", { opBody: "op body v2" }],
    ["host section", { host: ["house rule"] }],
    ["operator field", { extra: { autonomy: 3 } }],
  ] as [string, Parameters<typeof fixture>[0]][])("changes when the %s changes", async (_name, change) => {
    expect(await fixture(change)).not.toBe(await fixture())
  })
})

describe("no I/O except through the injected loader", () => {
  it("resolves from in-memory loaders alone, calling each only with the ref the operator wrote", async () => {
    const calls: string[] = []
    const fetchSpy = vi.fn(() => {
      throw new Error("network")
    })
    vi.stubGlobal("fetch", fetchSpy)
    try {
      const operator = operatorOf({ extends: "base-ref", persona: "persona-ref", identity: "identity-ref", policy: "policy-ref" })
      const sources = base({
        agent: async ref => (calls.push(`agent:${ref}`), agentEntry("base"))
        ,
        persona: async ref => (calls.push(`persona:${ref}`), { persona: { name: "p", title: "t" } as never }),
        identity: async ref => (calls.push(`identity:${ref}`), { identity: { name: "i", title: "t" } as never }),
        policy: async ref => (calls.push(`policy:${ref}`), policyOf()),
      })
      const first = await resolveOperator({ operator }, sources)
      const second = await resolveOperator({ operator }, sources)
      expect(calls.slice(0, 4).sort()).toEqual(["agent:base-ref", "identity:identity-ref", "persona:persona-ref", "policy:policy-ref"])
      expect(second).toEqual(first)
      expect(fetchSpy).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it("imports no I/O, clock or randomness module in any resolve source file", () => {
    const dir = join(dirname(fileURLToPath(import.meta.url)), "..")
    const files = readdirSync(dir).filter(f => /^resolve.*\.ts$/.test(f))
    expect(files.length).toBeGreaterThan(0)
    for (const f of files) {
      const src = readFileSync(join(dir, f), "utf8")
      const imports = [...src.matchAll(/from\s+"([^"]+)"/g)].map(m => m[1]!)
      const forbidden = imports.filter(i => /^(node:)?(fs|fs\/promises|net|http|https|child_process|os|path|dns|tls)$/.test(i))
      expect(forbidden, f).toEqual([])
      expect(src, f).not.toMatch(/Date\.now|new Date\(|Math\.random|process\.env|\bfetch\(/)
    }
  })
})
