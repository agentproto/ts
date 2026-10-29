import { agentFrontmatterSchema } from "@agentproto/agent"
import { describe, expect, it } from "vitest"
import { operatorManifestFrontmatterSchema } from "../manifest/index.js"

const agent = agentFrontmatterSchema.shape as Record<string, { safeParse(v: unknown): { success: boolean } }>
const operator = operatorManifestFrontmatterSchema.shape as typeof agent

// AGENT keys the operator owns or re-declares on purpose.
const NOT_INHERITED = new Set(["schema", "id"])
// AGENT keys whose item shape an operator widens (deprecated forms, mcp ref).
const WIDENED = new Set(["tools", "skills", "memory", "governance"])
// An operator tags with the AIP-9 kebab pattern, narrower than the AGENT free string.
const NARROWED = new Set(["tags"])

const PROBES: Record<string, unknown[]> = {
  version: ["1.0.0", "v1", 3],
  description: ["fine", "", 5],
  autonomy: [0, 10, 11, -1, 2.5, "5"],
  traits: [{ a: 3 }, { a: 11 }, { a: "x" }],
  boundaries: [["a"], [""], "a"],
  publish: [{ visibility: "public" }, { visibility: "world" }, { x: 1 }],
  actions: [{ granted: ["x"] }, { granted: "x" }, { extra: 1 }],
  workflows: [["w"], "w"],
  routines: [["r"], "r"],
  delegates_to: [["d"], "d"],
  on: [{ "session:start": "a" }, { "session:start": "" }, "x"],
  metadata: [{ a: 1 }, "x"],
}

describe("an operator carries the AGENT fields by reference (C2)", () => {
  it("declares every AGENT key, or says why not", () => {
    const missing = Object.keys(agent).filter(
      (k) => !(k in operator) && !NOT_INHERITED.has(k),
    )
    expect(missing).toEqual([])
  })

  it("accepts and rejects exactly what the AGENT schema does, key by key", () => {
    const keys = Object.keys(agent).filter(
      (k) => !NOT_INHERITED.has(k) && !WIDENED.has(k) && !NARROWED.has(k),
    )
    expect(keys.length).toBeGreaterThan(10)
    let rejected = 0
    for (const key of keys) {
      for (const value of PROBES[key] ?? []) {
        const a = agent[key]!.safeParse(value).success
        const o = operator[key]!.safeParse(value).success
        expect(o, `${key} = ${JSON.stringify(value)}`).toBe(a)
        if (!a) rejected++
      }
    }
    expect(rejected).toBeGreaterThan(10)
  })

  it("does not apply an AGENT default to an operator that omits the field", () => {
    for (const key of ["version", "autonomy", "boundaries", "traits", "publish", "tags"]) {
      expect(operator[key]!.safeParse(undefined).success, key).toBe(true)
    }
    const parsed = operatorManifestFrontmatterSchema.parse({
      id: "lex",
      name: "Lex",
      persona_summary: "Researcher.",
    })
    expect(Object.keys(parsed).sort()).toEqual(["id", "name", "persona_summary"])
  })

  it("keeps the AGENT item shapes valid inside the widened lists", () => {
    const parsed = operatorManifestFrontmatterSchema.safeParse({
      id: "lex",
      name: "Lex",
      persona_summary: "Researcher.",
      tools: ["tool:katchy/search", { ref: "x" }, { kind: "mcp", server: "k" }],
      skills: ["skill:seo", { id: "seo", version: "1.0.0" }],
    })
    expect(parsed.success).toBe(true)
  })

  it("holds the widened list items to a real shape, not z.any()", () => {
    const parse = (extra: Record<string, unknown>) =>
      operatorManifestFrontmatterSchema.safeParse({
        id: "lex",
        name: "Lex",
        persona_summary: "Researcher.",
        ...extra,
      })
    expect(parse({ tools: [{ kind: "mcp" }] }).success).toBe(false)
    expect(parse({ tools: [{ id: 3 }] }).success).toBe(false)
    expect(parse({ skills: [{ id: "NOT A SLUG" }] }).success).toBe(false)
    expect(parse({ tools: [{ id: "search", source: "x" }] }).success).toBe(true)
  })
})
