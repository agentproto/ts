import { describe, expect, it } from "vitest"
import {
  defineMemory,
  isAllowedStatusTransition,
  isInForce,
  memoryStatus,
  MemoryParseError,
  MemoryValidationError,
  parseMemory,
  renderMemory,
  validateMemory,
  type MemoryDocument,
} from "../index.js"

const FEEDBACK: MemoryDocument = {
  schema: "memory/v1",
  slug: "cite-sources",
  kind: "feedback",
  title: "Cite sources",
  updated_at: "2026-10-13T11:30:00.000Z",
  id: "mem_test001",
  name: "cite-sources",
  type: "feedback",
  polarity: "do",
  description: "Cite sources",
  tags: ["global", "agent:assistant"],
  lifetime: { kind: "durable" },
  status: "active",
  created: "2026-10-13T11:30:00.000Z",
  written: "2026-10-13T11:30:00.000Z",
  decidedBy: { rule: "lens-confident", source: "builtin" },
  provenance: {
    source: "converse",
    quote: "always cite your sources",
    at: "2026-10-13T11:00:00.000Z",
    extractorVersion: "lens@3",
  },
  capture: { mode: "batch", producer: "clerk:user", capturedAt: "2026-10-13T11:00:00.000Z" },
  body: "Always cite sources.\n",
}

const USER: MemoryDocument = {
  schema: "memory/v1",
  slug: "prefers-short-answers",
  kind: "user",
  title: "Prefers short answers",
  updated_at: "2026-10-20T08:00:00Z",
  provenance: { source: "converse", at: "2026-10-20T08:00:00Z", sessionId: "sess_1" },
  body: "Keep answers short.\n\nExpand only when asked.\n",
}

const LEGACY: MemoryDocument = {
  id: "mem_legacy01",
  name: "repo-uses-pnpm",
  type: "project",
  body: "The repo uses pnpm.\n",
}

function errorAt(doc: unknown, path: string, rule?: string) {
  const result = validateMemory(doc)
  expect(result.ok).toBe(false)
  const hit = result.errors.find((e) => e.path === path)
  expect(hit, JSON.stringify(result.errors)).toBeDefined()
  if (rule) expect(hit?.rule).toBe(rule)
  return hit
}

describe("validateMemory: valid items", () => {
  it.each([
    ["feedback", FEEDBACK],
    ["user", USER],
    ["legacy trio", LEGACY],
    ["archived", { ...USER, status: "archived" }],
    ["superseded", { ...USER, status: "superseded" }],
    ["until lifetime", { ...USER, lifetime: { kind: "until", at: "2027-01-01T00:00:00Z" } }],
    [
      "while lifetime",
      { ...USER, lifetime: { kind: "while", anchor: { kind: "pr", repo: "o/r", number: 7 } } },
    ],
  ])("accepts a %s item", (_, doc) => {
    const result = validateMemory(doc)
    expect(result.errors).toEqual([])
    expect(result.ok).toBe(true)
  })

  it("accepts any body (rule 12)", () => {
    expect(validateMemory({ ...USER, body: "---\nnot: frontmatter\n---\n" }).ok).toBe(true)
  })
})

describe("validateMemory: schema", () => {
  it("rejects an unknown type", () => {
    errorAt({ ...LEGACY, type: "opinion" }, "type", "schema")
  })

  it("rejects an unknown top-level field", () => {
    errorAt({ ...USER, anchors: [] }, "anchors", "schema")
  })

  it("rejects unknown fields inside lifetime and its anchor", () => {
    errorAt({ ...USER, lifetime: { kind: "durable", ttl: 3 } }, "lifetime.ttl", "schema")
    errorAt(
      { ...USER, evidence: { lifetime: { kind: "durable", ttl: 3 } } },
      "evidence.lifetime.ttl",
      "schema",
    )
    errorAt(
      { ...USER, lifetime: { kind: "while", anchor: { kind: "global", extra: 1 } } },
      "lifetime.anchor.extra",
      "schema",
    )
  })

  it("rejects an item with neither the canonical fields nor the legacy trio", () => {
    errorAt({ slug: "half-item", kind: "user", body: "" }, "title", "schema")
  })

  it("rejects an empty provenance.sessionId and provenance.ref (minLength 1)", () => {
    errorAt({ ...USER, provenance: { ...USER.provenance, sessionId: "" } }, "provenance.sessionId")
    errorAt({ ...USER, provenance: { ...USER.provenance, ref: "" } }, "provenance.ref")
  })

  it("rejects lifetime 'until' without at", () => {
    errorAt({ ...USER, lifetime: { kind: "until" } }, "lifetime.at", "schema")
  })

  it("rejects lifetime 'while' without anchor", () => {
    errorAt({ ...USER, lifetime: { kind: "while" } }, "lifetime.anchor", "schema")
  })

  it("applies the lifetime rules to evidence.lifetime too", () => {
    errorAt({ ...USER, evidence: { lifetime: { kind: "until" } } }, "evidence.lifetime.at")
  })

  it("rejects a non-string where a string is required (rule 3 after a YAML read)", () => {
    errorAt({ ...USER, title: true }, "title", "schema")
  })
})

describe("validateMemory: AIP-72 rules", () => {
  it("section 2: rejects a kind outside the memory types", () => {
    errorAt({ ...USER, kind: "opinion" }, "kind", "section-2")
  })

  it("rule 1: canonical mode requires the canonical fields", () => {
    const result = validateMemory(LEGACY, { canonical: true })
    expect(result.ok).toBe(false)
    expect(result.errors.map((e) => [e.path, e.rule])).toEqual([
      ["schema", "rule-1"],
      ["slug", "rule-1"],
      ["kind", "rule-1"],
      ["title", "rule-1"],
      ["updated_at", "rule-1"],
    ])
  })

  it("rule 2: rejects kind and type that differ", () => {
    errorAt({ ...FEEDBACK, kind: "user", polarity: undefined }, "kind", "rule-2")
  })

  it("rule 4: rejects an empty optional value", () => {
    errorAt({ ...USER, description: "" }, "description", "rule-4")
    errorAt({ ...USER, provenance: { ...USER.provenance, quote: "" } }, "provenance.quote", "rule-4")
    errorAt({ ...USER, capture: {} }, "capture", "rule-4")
  })

  it("rule 5: rejects polarity on a non-feedback item", () => {
    errorAt({ ...USER, polarity: "do" }, "polarity", "rule-5")
    errorAt({ ...LEGACY, polarity: "dont" }, "polarity", "rule-5")
  })

  it("rule 8: warns, without failing, when provenance source or at is missing", () => {
    const result = validateMemory(LEGACY)
    expect(result.ok).toBe(true)
    expect(result.warnings.map((w) => w.path)).toEqual(["provenance.source", "provenance.at"])
  })
})

describe("defineMemory", () => {
  it("returns a deeply frozen handle that does not alias the input", () => {
    const input = structuredClone(FEEDBACK)
    const memory = defineMemory(input)
    expect(memory).toEqual(FEEDBACK)
    expect(Object.isFrozen(memory)).toBe(true)
    expect(Object.isFrozen(memory.provenance)).toBe(true)
    expect(Object.isFrozen(input.provenance)).toBe(false)
  })

  it("fills only status (active) and body (empty), never tags", () => {
    const { body: _b, ...noBody } = USER
    const memory = defineMemory(noBody)
    expect(memory.status).toBe("active")
    expect(memory.body).toBe("")
    expect("tags" in memory).toBe(false)
  })

  it("throws a MemoryValidationError naming the field", () => {
    const err = (() => {
      try {
        defineMemory({ ...USER, provenance: { sessionId: "" } })
      } catch (e) {
        return e
      }
    })()
    expect(err).toBeInstanceOf(MemoryValidationError)
    expect((err as MemoryValidationError).field).toBe("provenance.sessionId")
    expect((err as Error).message).toMatch(/^defineMemory \(AIP-72\): provenance\.sessionId/)
  })

  it("rejects a legacy-only item (rule 1)", () => {
    expect(() => defineMemory(LEGACY)).toThrow(MemoryValidationError)
  })
})

describe("parseMemory / renderMemory", () => {
  it.each([
    ["feedback", FEEDBACK],
    ["user", USER],
    ["legacy", LEGACY],
    ["archived", { ...FEEDBACK, status: "archived" as const }],
    ["empty body", { ...USER, body: "" }],
    ["body with a leading blank line", { ...USER, body: "\nindented start\n" }],
  ])("round-trips a %s item", (_, doc) => {
    const md = renderMemory(doc)
    expect(parseMemory(md)).toEqual(doc)
    expect(renderMemory(parseMemory(md))).toBe(md)
  })

  it("quotes every string so YAML 1.1 words stay strings (rule 3)", () => {
    const md = renderMemory({ ...LEGACY, name: "no", description: "2026" })
    expect(md).toContain('name: "no"')
    expect(md).toContain('description: "2026"')
    expect(parseMemory(md).name).toBe("no")
  })

  it("a status-only rewrite changes only the status line (rule 6)", () => {
    const before = renderMemory(FEEDBACK).split("\n")
    const after = renderMemory({ ...FEEDBACK, status: "superseded" }).split("\n")
    const changed = before.filter((line, i) => line !== after[i])
    expect(changed).toEqual(['status: "active"'])
  })

  it("parses a hand-written file and keeps unquoted date-times as strings", () => {
    const doc = parseMemory(
      "---\nid: mem_x\nname: x\ntype: user\ncreated: 2026-10-13T11:30:00Z\n---\n\nBody.\n",
    )
    expect(doc.created).toBe("2026-10-13T11:30:00Z")
    expect(doc.body).toBe("Body.\n")
    expect(validateMemory(doc).ok).toBe(true)
  })

  it("reads an unquoted boolean as a boolean, which validation rejects", () => {
    const doc = parseMemory("---\nid: mem_x\nname: true\ntype: user\n---\n")
    expect(doc.name).toBe(true)
    errorAt(doc, "name", "schema")
  })

  it("rejects a file without frontmatter or with a body key", () => {
    expect(() => parseMemory("just text")).toThrow(MemoryParseError)
    expect(() => parseMemory("---\nbody: x\n---\n")).toThrow(MemoryParseError)
  })

  it("renderMemory refuses an invalid document", () => {
    expect(() => renderMemory({ ...USER, polarity: "do" })).toThrow(MemoryValidationError)
  })
})

describe("lifecycle helpers", () => {
  it("reads an absent status as active (rule 9)", () => {
    expect(memoryStatus(LEGACY)).toBe("active")
  })

  it("allows only active -> superseded | archived (rule 7)", () => {
    expect(isAllowedStatusTransition(undefined, "archived")).toBe(true)
    expect(isAllowedStatusTransition("active", "superseded")).toBe(true)
    expect(isAllowedStatusTransition("archived", "active")).toBe(false)
    expect(isAllowedStatusTransition("superseded", "archived")).toBe(false)
  })

  it("is not in force once retired or past an until (rules 10, 11)", () => {
    const now = new Date("2026-11-01T00:00:00Z")
    expect(isInForce(USER, now)).toBe(true)
    expect(isInForce({ ...USER, status: "superseded" }, now)).toBe(false)
    expect(isInForce({ lifetime: { kind: "until", at: "2026-10-31T00:00:00Z" } }, now)).toBe(false)
    expect(isInForce({ lifetime: { kind: "until", at: "2026-12-01T00:00:00Z" } }, now)).toBe(true)
  })
})
