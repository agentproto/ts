import { describe, it, expect } from "vitest"
import { defineOperator } from "../define-operator.js"
import type { OperatorDefinition } from "../types.js"

const MINIMAL: OperatorDefinition = {
  id: "lex",
  name: "Lex",
  persona_summary: "Researcher who validates sources before recommending.",
  version: "1.0.0",
  role: "researcher",
  boundaries: ["Never recommend a paper without checking the publication date."],
}

describe("defineOperator (AIP-9) — basic shape", () => {
  it("produces a frozen handle with defaults applied", () => {
    const op = defineOperator(MINIMAL)
    expect(op.id).toBe("lex")
    expect(op.name).toBe("Lex")
    expect(op.persona_summary).toContain("validates sources")
    expect(op.version).toBe("1.0.0")
    expect(op.role).toEqual({ ref: "researcher" })
    expect(op.boundaries).toHaveLength(1)
    expect(op.warnings).toEqual([])
    expect(op.skills).toEqual([])
    expect(op.tools).toEqual([])
    expect(op.capabilities).toEqual([])
    expect(op.tags).toEqual([])
    expect(op.metadata).toEqual({})
    expect(op.participation?.mode).toBe("mention-only")
    expect(op.participation?.reactions).toBe(false)
    expect(Object.isFrozen(op)).toBe(true)
    expect(Object.isFrozen(op.role)).toBe(true)
  })

  it("needs neither version nor profile", () => {
    const op = defineOperator({
      id: "lex",
      name: "Lex",
      persona_summary: "Researcher.",
      role: "researcher",
    })
    expect(op.version).toBeUndefined()
    expect(op.profile).toBeUndefined()
  })

  it("keeps a structured role with its bind and with", () => {
    const op = defineOperator({
      ...MINIMAL,
      role: { ref: "researcher", bind: { board: "ws://collections/b" }, with: { language: "en" } },
    })
    expect(op.role).toEqual({
      ref: "researcher",
      bind: { board: "ws://collections/b" },
      with: { language: "en" },
    })
  })

  it("rejects an empty role ref and a non-scalar with value", () => {
    expect(() => defineOperator({ ...MINIMAL, role: "" })).toThrow(/role must be/)
    expect(() =>
      defineOperator({ ...MINIMAL, role: { ref: "" } }),
    ).toThrow(/role must be/)
    expect(() =>
      defineOperator({
        ...MINIMAL,
        role: { ref: "researcher", with: { x: {} as never } },
      }),
    ).toThrow(/role.with.x/)
  })

  it("rejects an autonomy outside 0 to 10", () => {
    expect(() => defineOperator({ ...MINIMAL, autonomy: 11 })).toThrow(/autonomy/)
  })
})

describe("defineOperator: deprecated forms are accepted and warned about", () => {
  const fields = (op: { warnings: readonly { code: string; field?: string }[] }) =>
    op.warnings
      .filter((w) => w.code === "operator_field_deprecated")
      .map((w) => w.field)

  it("maps profile.voice and profile.boundaries onto persona and boundaries", () => {
    const op = defineOperator({
      ...MINIMAL,
      profile: {
        role: "Lead researcher.",
        voice: "Direct.",
        boundaries: ["Never recommend a paper without checking the publication date.", "Cite sources."],
      },
    })
    expect(op.persona).toEqual({ inline: { voice: "Direct." } })
    expect(op.boundaries).toEqual([
      "Never recommend a paper without checking the publication date.",
      "Cite sources.",
    ])
    expect(op.profile).toEqual({ role: "Lead researcher." })
    expect(fields(op).sort()).toEqual(["profile.boundaries", "profile.voice"])
  })

  it("does not override an explicit persona with profile.voice", () => {
    const op = defineOperator({
      ...MINIMAL,
      persona: "persona:calm",
      profile: { voice: "Direct." },
    })
    expect(op.persona).toBe("persona:calm")
  })

  it("reads company as home", () => {
    const op = defineOperator({ ...MINIMAL, company: "ws://companies/acme" })
    expect(op.home).toBe("ws://companies/acme")
    expect(fields(op)).toEqual(["company"])
    const both = defineOperator({
      ...MINIMAL,
      home: "ws://workspaces/w",
      company: "ws://companies/acme",
    })
    expect(both.home).toBe("ws://workspaces/w")
  })

  it("maps the legacy memory kinds onto the AGENT memory config", () => {
    const memory = (m: object) =>
      defineOperator({ ...MINIMAL, memory: m as never }).memory
    expect(memory({ kind: "none" })).toEqual({ enabled: false })
    expect(memory({ kind: "thread" })).toEqual({ scope: "per-thread" })
    expect(memory({ kind: "operator-context" })).toEqual({})
    expect(
      memory({ kind: "external", external: { uri: "pg://db" } }),
    ).toEqual({ store: "pg://db" })
  })

  it("keeps the legacy memory as written and warns about share_with", () => {
    const op = defineOperator({
      ...MINIMAL,
      memory: { kind: "operator-context", policy: "redactable", share_with: ["atlas"] },
    })
    expect(op.legacy?.memory?.policy).toBe("redactable")
    expect(fields(op)).toEqual(expect.arrayContaining(["memory", "memory.share_with"]))
  })

  it("maps the legacy governance autonomy onto the 0 to 10 scale", () => {
    const autonomy = (a: "gated" | "supervised" | "autonomous") =>
      defineOperator({
        ...MINIMAL,
        governance: { audit_log: "audit:lex", autonomy: a },
      }).autonomy
    expect(autonomy("gated")).toBe(0)
    expect(autonomy("supervised")).toBe(5)
    expect(autonomy("autonomous")).toBe(10)
    const op = defineOperator({
      ...MINIMAL,
      autonomy: 7,
      governance: { audit_log: "audit:lex", autonomy: "gated" },
    })
    expect(op.autonomy).toBe(7)
    expect(op.legacy?.governance?.audit_log).toBe("audit:lex")
  })

  it("warns that runtime.session is a hint", () => {
    const op = defineOperator({
      ...MINIMAL,
      runtime: { kind: "in-process", session: { mode: "persistent" } },
    })
    expect(fields(op)).toEqual(["runtime.session"])
  })

  it("keeps legacy governance policies and audit_log in legacy and says so", () => {
    const op = defineOperator({
      ...MINIMAL,
      governance: {
        policies: ["policy:guard"],
        audit_log: "audit:lex",
        autonomy: "supervised",
      },
    })
    expect(op.policy).toBeUndefined()
    expect(op.governance).toBeUndefined()
    expect(op.legacy?.governance).toEqual({
      policies: ["policy:guard"],
      audit_log: "audit:lex",
      autonomy: "supervised",
    })
    const warning = op.warnings.find(
      (w) => w.code === "operator_field_deprecated" && w.field === "governance",
    )
    expect(warning?.message).toMatch(/remain only in legacy/)
  })

  it("does not mistake an AGENT-form memory with a policy key for the legacy form", () => {
    const op = defineOperator({
      ...MINIMAL,
      memory: { policy: "custom" } as never,
    })
    expect(op.memory).toEqual({ policy: "custom" })
    expect(op.legacy).toBeUndefined()
    expect(fields(op)).toEqual([])
  })

  it("does not mistake an AGENT-form governance with a policies key for the legacy form", () => {
    const op = defineOperator({
      ...MINIMAL,
      governance: { policies: ["policy:guard"] } as never,
    })
    expect(op.governance).toEqual({ policies: ["policy:guard"] })
    expect(op.legacy).toBeUndefined()
    expect(fields(op)).toEqual([])
  })
})

describe("defineOperator — id pattern (slug-style, no dots/underscores)", () => {
  it("rejects uppercase", () => {
    expect(() => defineOperator({ ...MINIMAL, id: "Lex" })).toThrow(
      /defineOperator \(AIP-9\): invalid id 'Lex'/,
    )
  })
  it("rejects single character", () => {
    expect(() => defineOperator({ ...MINIMAL, id: "a" })).toThrow(
      /invalid id 'a'/,
    )
  })
  it("rejects underscores", () => {
    expect(() => defineOperator({ ...MINIMAL, id: "a_b" })).toThrow(
      /invalid id 'a_b'/,
    )
  })
  it("rejects trailing dash", () => {
    expect(() => defineOperator({ ...MINIMAL, id: "lex-" })).toThrow(
      /invalid id 'lex-'/,
    )
  })
  it("accepts the canonical slug shape", () => {
    expect(defineOperator({ ...MINIMAL, id: "lex" }).id).toBe("lex")
    expect(defineOperator({ ...MINIMAL, id: "lex-2" }).id).toBe("lex-2")
    expect(defineOperator({ ...MINIMAL, id: "alex42" }).id).toBe("alex42")
  })
})

describe("defineOperator — persona_summary length (1–280)", () => {
  it("rejects empty persona_summary", () => {
    expect(() =>
      defineOperator({ ...MINIMAL, persona_summary: "" }),
    ).toThrow(/description must be 1–280 chars/)
  })
  it("rejects oversized persona_summary", () => {
    expect(() =>
      defineOperator({ ...MINIMAL, persona_summary: "x".repeat(281) }),
    ).toThrow(/description must be 1–280 chars/)
  })
})

describe("defineOperator — spec-9 cross-field invariants", () => {
  it("rejects invalid version", () => {
    expect(() => defineOperator({ ...MINIMAL, version: "v1" })).toThrow(
      /version must match/,
    )
  })

  it("autonomy 0 forbids participation.mode='proactive'", () => {
    expect(() =>
      defineOperator({ ...MINIMAL, autonomy: 0, participation: { mode: "proactive" } }),
    ).toThrow(/autonomy=0 forbids participation.mode='proactive'/)
    expect(defineOperator({ ...MINIMAL, autonomy: 0 }).participation.mode).toBe("mention-only")
  })

  it("requires audit_log shape audit:<slug>", () => {
    expect(() =>
      defineOperator({
        ...MINIMAL,
        governance: { audit_log: "channel-1", autonomy: "supervised" },
      }),
    ).toThrow(/governance.audit_log must match/)
  })

  it("requires policies entries to look like policy:<slug>", () => {
    expect(() =>
      defineOperator({
        ...MINIMAL,
        governance: {
          audit_log: "audit:lex",
          autonomy: "supervised",
          policies: ["not-a-policy-ref"],
        },
      }),
    ).toThrow(/governance.policies entry 'not-a-policy-ref'/)
  })

  it("memory.kind='external' requires external.uri", () => {
    expect(() =>
      defineOperator({
        ...MINIMAL,
        memory: { kind: "external" },
      }),
    ).toThrow(/memory.kind='external' requires memory.external.uri/)
  })

  it("autonomy='gated' forbids participation.mode='proactive'", () => {
    expect(() =>
      defineOperator({
        ...MINIMAL,
        governance: { audit_log: "audit:lex", autonomy: "gated" },
        participation: { mode: "proactive" },
      }),
    ).toThrow(
      /governance.autonomy='gated' forbids participation.mode='proactive'/,
    )
  })

  it("autonomy='gated' permits participation.mode='mention-only' (default) and 'silent'", () => {
    const op1 = defineOperator({
      ...MINIMAL,
      governance: { audit_log: "audit:lex", autonomy: "gated" },
    })
    expect(op1.participation?.mode).toBe("mention-only")

    const op2 = defineOperator({
      ...MINIMAL,
      governance: { audit_log: "audit:lex", autonomy: "gated" },
      participation: { mode: "silent" },
    })
    expect(op2.participation?.mode).toBe("silent")
  })

  it("validates the resolved autonomy, so an explicit value overrides a legacy 'gated'", () => {
    const op = defineOperator({
      ...MINIMAL,
      autonomy: 7,
      governance: { audit_log: "audit:lex", autonomy: "gated" },
      participation: { mode: "proactive" },
    })
    expect(op.autonomy).toBe(7)
    expect(op.participation?.mode).toBe("proactive")
  })
})

describe("defineOperator — runtime binding (AIP-45 hook)", () => {
  it("defaults runtime to undefined when not declared", () => {
    const op = defineOperator(MINIMAL)
    expect(op.runtime).toBeUndefined()
  })

  it("accepts runtime.kind=in-process without a ref", () => {
    const op = defineOperator({
      ...MINIMAL,
      runtime: { kind: "in-process" },
    })
    expect(op.runtime?.kind).toBe("in-process")
    expect(op.runtime?.ref).toBeUndefined()
  })

  it("accepts runtime.kind=agent-cli with a ref", () => {
    const op = defineOperator({
      ...MINIMAL,
      runtime: {
        kind: "agent-cli",
        ref: "@agentproto/adapter-hermes#hermes",
        session: { mode: "persistent", idle_timeout_ms: 1_800_000 },
      },
    })
    expect(op.runtime?.kind).toBe("agent-cli")
    expect(op.runtime?.ref).toBe("@agentproto/adapter-hermes#hermes")
    expect(op.runtime?.session?.mode).toBe("persistent")
    expect(Object.isFrozen(op.runtime)).toBe(true)
    expect(Object.isFrozen(op.runtime?.session)).toBe(true)
  })

  it("rejects runtime.kind=agent-cli without a ref", () => {
    expect(() =>
      defineOperator({
        ...MINIMAL,
        runtime: { kind: "agent-cli" },
      }),
    ).toThrow(/runtime.kind='agent-cli' requires runtime.ref/)
  })
})

describe("defineOperator — skills + tools accept ref shapes", () => {
  it("accepts string and object skill refs", () => {
    const op = defineOperator({
      ...MINIMAL,
      skills: ["fact-check", { id: "summarise", source: "agentik" }],
    })
    expect(op.skills).toHaveLength(2)
  })
  it("accepts MCP tool refs", () => {
    const op = defineOperator({
      ...MINIMAL,
      tools: [{ kind: "mcp", server: "https://mcp.local", allow: ["search"] }],
    })
    expect(op.tools).toHaveLength(1)
  })
})
