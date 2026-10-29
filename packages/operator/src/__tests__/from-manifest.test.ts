import { describe, it, expect } from "vitest"
import {
  operatorFromManifest,
  parseOperatorManifest,
} from "../manifest/index.js"

const SAMPLE = `---
schema: agentoperators/v1
name: Lex
id: lex
persona_summary: Researcher who validates sources before recommending.
version: 1.0.0
profile:
  role: Lead researcher.
  voice: Direct, source-citing, second-person.
  boundaries:
    - Never recommend a paper without checking the publication date.
skills:
  - fact-check
  - id: summarise
    source: agentik
tools:
  - kind: mcp
    server: mcp-local
    allow:
      - search
memory:
  kind: operator-context
governance:
  audit_log: audit:lex
  autonomy: supervised
capabilities:
  - research
participation:
  mode: mention-only
  reactions: true
tags: [research]
metadata:
  vendor.namespace: katchy
---

# Lex
Body content here.
`

describe("parseOperatorManifest", () => {
  it("parses a full OPERATOR.md", () => {
    const m = parseOperatorManifest(SAMPLE)
    expect(m.frontmatter.id).toBe("lex")
    expect(m.frontmatter.profile?.boundaries).toHaveLength(1)
    expect(m.frontmatter.skills).toHaveLength(2)
    expect(m.frontmatter.tools).toHaveLength(1)
    expect(m.frontmatter.governance).toEqual({ audit_log: "audit:lex", autonomy: "supervised" })
    expect(m.body).toContain("# Lex")
  })

  it("accepts the AIP-70 registry operator/v1 tag", () => {
    const registry = SAMPLE.replace(
      "schema: agentoperators/v1",
      "schema: operator/v1",
    )
    const m = parseOperatorManifest(registry)
    expect(m.frontmatter.schema).toBe("operator/v1")
    expect(m.frontmatter.id).toBe("lex")
  })

  it("accepts the legacy agentoperators/v1 tag", () => {
    const m = parseOperatorManifest(SAMPLE)
    expect(m.frontmatter.schema).toBe("agentoperators/v1")
  })

  it("accepts the legacy singular agentoperator/v1 tag", () => {
    const legacy = SAMPLE.replace(
      "schema: agentoperators/v1",
      "schema: agentoperator/v1",
    )
    const m = parseOperatorManifest(legacy)
    expect(m.frontmatter.schema).toBe("agentoperator/v1")
    expect(m.frontmatter.id).toBe("lex")
  })

  it("accepts a manifest with no schema tag", () => {
    const untagged = SAMPLE.replace(/^schema: .*\n/m, "")
    expect(parseOperatorManifest(untagged).frontmatter.schema).toBeUndefined()
  })

  it("rejects an unknown schema tag", () => {
    const bad = SAMPLE.replace(
      "schema: agentoperators/v1",
      "schema: agentoperators/v2",
    )
    expect(() => parseOperatorManifest(bad)).toThrow(/schema/)
  })

  it("rejects a missing required field (persona_summary)", () => {
    const bad = SAMPLE.replace(/^persona_summary: .*\n/m, "")
    expect(() => parseOperatorManifest(bad)).toThrow(/persona_summary/)
  })

  it("accepts a manifest with neither version nor profile", () => {
    const lean = SAMPLE.replace(/^version: .*\n/m, "").replace(
      /^profile:\n(?: {2}.*\n| {4}.*\n)+/m,
      "",
    )
    const m = parseOperatorManifest(lean)
    expect(m.frontmatter.version).toBeUndefined()
    expect(m.frontmatter.profile).toBeUndefined()
  })

  it("rejects an unknown top-level key", () => {
    const bad = SAMPLE.replace(/^tags: .*$/m, "tags: [research]\nstray: 1")
    expect(() => parseOperatorManifest(bad)).toThrow(/stray/)
  })

  it("does not invent the AGENT defaults an operator never wrote", () => {
    const m = parseOperatorManifest(SAMPLE)
    expect(m.frontmatter.autonomy).toBeUndefined()
    expect(m.frontmatter.version).toBe("1.0.0")
    const lean = parseOperatorManifest(
      "---\nid: lex\nname: Lex\npersona_summary: Researcher.\n---\n",
    )
    expect(lean.frontmatter).toEqual({ id: "lex", name: "Lex", persona_summary: "Researcher." })
  })

  it("holds an object written in the deprecated memory form to that form", () => {
    const bad = SAMPLE.replace("kind: operator-context", "kind: forever")
    expect(() => parseOperatorManifest(bad)).toThrow(/memory\.kind/)
  })

  it("rejects invalid id shape", () => {
    const bad = SAMPLE.replace(/^id: lex$/m, "id: BAD_ID")
    expect(() => parseOperatorManifest(bad)).toThrow(/id/)
  })
})

describe("operatorFromManifest", () => {
  it("produces a typed handle equivalent to the TS path", () => {
    const m = parseOperatorManifest(SAMPLE)
    const op = operatorFromManifest(m)
    expect(op.id).toBe("lex")
    expect(op.legacy?.governance?.audit_log).toBe("audit:lex")
    expect(op.legacy?.memory?.kind).toBe("operator-context")
    expect(op.autonomy).toBe(5)
    expect(op.participation?.reactions).toBe(true)
    expect(op.metadata).toEqual({ "vendor.namespace": "katchy" })
    expect(Object.isFrozen(op)).toBe(true)
  })

  it("propagates the autonomy=gated cross-field rule", () => {
    const bad = SAMPLE.replace(
      /autonomy: supervised/,
      "autonomy: gated",
    ).replace(/mode: mention-only/, "mode: proactive")
    const m = parseOperatorManifest(bad)
    expect(() => operatorFromManifest(m)).toThrow(
      /governance.autonomy='gated' forbids participation.mode='proactive'/,
    )
  })
})
