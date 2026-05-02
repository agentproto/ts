import { describe, it, expect } from "vitest"
import {
  operatorFromManifest,
  parseOperatorManifest,
} from "../manifest/index.js"

const SAMPLE = `---
schema: agentoperator/v1
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
    server: https://mcp.local
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
    expect(m.frontmatter.profile.boundaries).toHaveLength(1)
    expect(m.frontmatter.skills).toHaveLength(2)
    expect(m.frontmatter.tools).toHaveLength(1)
    expect(m.frontmatter.governance?.autonomy).toBe("supervised")
    expect(m.body).toContain("# Lex")
  })

  it("rejects missing required field (profile)", () => {
    const bad = SAMPLE.replace(/profile:[\s\S]*?boundaries:[\s\S]*?\.\n/, "")
    expect(() => parseOperatorManifest(bad)).toThrow(/profile/)
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
    expect(op.governance?.audit_log).toBe("audit:lex")
    expect(op.memory?.kind).toBe("operator-context")
    expect(op.memory?.policy).toBe("summarising") // default applied
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
