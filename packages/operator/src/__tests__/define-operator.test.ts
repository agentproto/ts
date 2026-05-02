import { describe, it, expect } from "vitest"
import { defineOperator } from "../define-operator.js"
import type { OperatorDefinition } from "../types.js"

const MINIMAL: OperatorDefinition = {
  id: "lex",
  name: "Lex",
  persona_summary: "Researcher who validates sources before recommending.",
  version: "1.0.0",
  profile: {
    role: "Lead researcher.",
    voice: "Direct, source-citing, second-person.",
    boundaries: [
      "Never recommend a paper without checking the publication date.",
    ],
  },
}

describe("defineOperator (AIP-9) — basic shape", () => {
  it("produces a frozen handle with defaults applied", () => {
    const op = defineOperator(MINIMAL)
    expect(op.id).toBe("lex")
    expect(op.name).toBe("Lex")
    expect(op.persona_summary).toContain("validates sources")
    expect(op.version).toBe("1.0.0")
    expect(op.profile.boundaries).toHaveLength(1)
    expect(op.skills).toEqual([])
    expect(op.tools).toEqual([])
    expect(op.capabilities).toEqual([])
    expect(op.tags).toEqual([])
    expect(op.metadata).toEqual({})
    expect(op.participation?.mode).toBe("mention-only")
    expect(op.participation?.reactions).toBe(false)
    expect(Object.isFrozen(op)).toBe(true)
    expect(Object.isFrozen(op.profile)).toBe(true)
  })

  it("memory.policy defaults to 'summarising' when memory is provided", () => {
    const op = defineOperator({
      ...MINIMAL,
      memory: { kind: "operator-context" },
    })
    expect(op.memory?.policy).toBe("summarising")
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
