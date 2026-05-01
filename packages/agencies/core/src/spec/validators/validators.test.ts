import { describe, it, expect } from "vitest"
import {
  validateAgency,
  validateService,
  validateProcedure,
  validateAgreement,
  checkAgenciesConsistency,
  type AgenciesWorkspaceFiles,
} from "./index.js"

describe("frontmatter validators", () => {
  it("validateAgency parses a markdown file with frontmatter", () => {
    const md = `---
schema: agentagencies/v1
doctype: agency
slug: acme-plumbing
name: Acme Plumbing
verticals: [plumbing-callout]
primaryServices: [emergency-callout]
defaultCurrency: EUR
autonomyPosture: hybrid
---

# Acme Plumbing

Operating profile.
`
    const result = validateAgency(md)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.frontmatter.slug).toBe("acme-plumbing")
      expect(result.value.body).toContain("Acme Plumbing")
    }
  })

  it("validateService rejects malformed frontmatter", () => {
    const md = `---
schema: agentagencies/v1
doctype: service
slug: BAD_SLUG_UPPERCASE
name: x
---

body
`
    const result = validateService(md)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errors.some(e => e.path.includes("slug"))).toBe(true)
    }
  })

  it("validateProcedure walks step shape", () => {
    const md = `---
schema: agentagencies/v1
doctype: procedure
slug: emergency-callout
name: Emergency callout
steps:
  - id: triage
    requiredSkill: dispatch
  - id: decide
    branch:
      - if: amount < cap
        action: proceed
      - else: true
        action: requestSignaturesTool
---

body
`
    const result = validateProcedure(md)
    expect(result.ok).toBe(true)
  })

  it("validateAgreement returns parse_error on malformed YAML", () => {
    const md = `---
schema: agentagencies/v1
doctype: agreement
slug: x
this: is: bad: yaml
---

body
`
    const result = validateAgreement(md)
    expect(result.ok).toBe(false)
  })
})

describe("checkAgenciesConsistency", () => {
  function workspace(): AgenciesWorkspaceFiles {
    return {
      services: new Map([
        [
          "emergency-callout",
          {
            frontmatter: {
              schema: "agentagencies/v1",
              doctype: "service",
              slug: "emergency-callout",
              name: "Emergency callout",
              requiredSkills: [],
              prerequisites: [],
              tags: [],
              publishable: true,
              defaultProcedure: "emergency-plumbing-callout",
            },
            body: "",
          } as never,
        ],
      ]),
      procedures: new Map([
        [
          "emergency-plumbing-callout",
          {
            frontmatter: {
              schema: "agentagencies/v1",
              doctype: "procedure",
              slug: "emergency-plumbing-callout",
              name: "Emergency plumbing callout",
              triggers: [],
              requiredSkills: [],
              defaultApprovers: [],
              steps: [{ id: "triage" }],
            },
            body: "",
          } as never,
        ],
      ]),
      counterparties: new Map([
        [
          "acme-corp",
          {
            frontmatter: {
              schema: "agentagencies/v1",
              doctype: "counterparty",
              slug: "acme-corp",
              name: "Acme",
              kind: "organization",
              displayName: "Acme",
              channels: [],
              source: "manual",
              tags: [],
            },
            body: "",
          } as never,
        ],
      ]),
      engagements: new Map([
        [
          "2026-acme",
          {
            frontmatter: {
              schema: "agentagencies/v1",
              doctype: "engagement",
              slug: "2026-acme",
              name: "Acme engagement",
              kind: "milestone",
              status: "in_progress",
              parties: [{ role: "client", party: "counterparty:acme-corp" }],
              primaryCounterpartyId: "acme-corp",
              serviceSlug: "emergency-callout",
              activeProcedure: "emergency-plumbing-callout",
              agreementPath: "AGREEMENT.md",
            },
            body: "",
          } as never,
        ],
      ]),
    }
  }

  it("returns no errors for a consistent workspace", () => {
    const errors = checkAgenciesConsistency(workspace())
    expect(errors).toEqual([])
  })

  it("flags dangling SERVICE.defaultProcedure", () => {
    const ws = workspace()
    const svc = ws.services!.get("emergency-callout")!
    ;(svc.frontmatter as { defaultProcedure?: string }).defaultProcedure =
      "nonexistent"
    const errors = checkAgenciesConsistency(ws)
    expect(errors.length).toBeGreaterThan(0)
    expect(
      errors.some(
        e => e.code === "dangling_ref" && e.path.includes("defaultProcedure")
      )
    ).toBe(true)
  })

  it("flags dangling ENGAGEMENT.primaryCounterpartyId", () => {
    const ws = workspace()
    ws.counterparties!.delete("acme-corp")
    const errors = checkAgenciesConsistency(ws)
    expect(errors.some(e => e.path.includes("primaryCounterpartyId"))).toBe(
      true
    )
  })
})
