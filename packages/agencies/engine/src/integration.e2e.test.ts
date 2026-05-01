import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { promises as fs } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import matter from "gray-matter"

import {
  signArtifact,
  recordAuditEvent,
  type GovernanceConfig,
} from "@agentproto/governance-engine"
import { validateAuditLog } from "@agentproto/governance/validators"

import {
  validateAgency,
  validateCounterparty,
  validateService,
  validateProcedure,
  validatePricingModel,
  validateEngagement,
  validateAgreement,
  checkAgenciesConsistency,
  type AgenciesWorkspaceFiles,
} from "@agentproto/agencies/validators"

/**
 * End-to-end integration test exercising the full stack:
 *
 *   companies.sh (COMPANY.md, AGENTS.md)
 *   ↓
 *   agentagencies/v1 (AGENCY.md, SERVICE.md, PROCEDURE.md, COUNTERPARTY.md,
 *                     ENGAGEMENT.md, AGREEMENT.md)
 *   ↓
 *   agentgovernance/v1 (signArtifact → signature.json + audit-log.jsonl)
 *
 * Verifies:
 *   - All doctypes parse + validate
 *   - Cross-doctype refs resolve (consistency)
 *   - Two parties sign the agreement (typed_name + agent_confirm)
 *   - The audit chain stays valid end-to-end
 */

const GENESIS = "0".repeat(64)
const SECRET = "e2e-integration-secret"

let tmpRoot: string
let governance: GovernanceConfig

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agencies-e2e-"))
  governance = {
    workspaceRoot: tmpRoot,
    genesisSeed: GENESIS,
    hmacSecret: SECRET,
  }
})

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true })
})

async function writeFile(rel: string, content: string): Promise<void> {
  const abs = path.join(tmpRoot, rel)
  await fs.mkdir(path.dirname(abs), { recursive: true })
  await fs.writeFile(abs, content, "utf8")
}

async function readFile(rel: string): Promise<string> {
  return fs.readFile(path.join(tmpRoot, rel), "utf8")
}

describe("end-to-end: agencies + governance + companies.sh", () => {
  it("scaffolds a workspace, signs an agreement, verifies the chain", async () => {
    // ─── 1. companies.sh foundation ─────────────────────────────────
    await writeFile(
      "COMPANY.md",
      `---
schema: agentcompanies/v1
slug: acme-design-studio
name: Acme Design Studio
description: Boutique design studio
---

# Acme Design Studio
`
    )

    await writeFile(
      "agents/jeremy/AGENTS.md",
      `---
schema: agentcompanies/v1
slug: jeremy
name: Jeremy
title: Founder & lead designer
---

# Jeremy

Founder.
`
    )

    // ─── 2. agentagencies/v1 — AGENCY.md ────────────────────────────
    const agencyMd = `---
schema: agentagencies/v1
doctype: agency
slug: acme-design-studio
name: Acme Design Studio
description: Boutique design studio operating under acme-design-studio.
verticals: [design-project]
primaryServices: [web-design]
defaultPricingModel: hourly-450
defaultCurrency: EUR
billingTimezone: Europe/Paris
fiscalYearStart: 2026-01-01
autonomyPosture: hybrid
includes:
  - ./services/
  - ./procedures/
  - ./pricing-models/
  - ./counterparties/
  - ./engagements/
---

# Acme Design Studio — Agency profile
`
    await writeFile("AGENCY.md", agencyMd)
    expect(validateAgency(agencyMd).ok).toBe(true)

    // ─── 3. SERVICE.md ──────────────────────────────────────────────
    const serviceMd = `---
schema: agentagencies/v1
doctype: service
slug: web-design
name: Website design
description: Multi-page marketing website
requiredSkills: [ui-design, ux-research]
defaultProcedure: design-project-execute
defaultPricingModel: hourly-450
estimatedDuration: P14D
tags: [design, web, marketing]
publishable: true
---

# Website design

Standard 2-week engagement.
`
    await writeFile("services/web-design/SERVICE.md", serviceMd)
    expect(validateService(serviceMd).ok).toBe(true)

    // ─── 3b. PRICING-MODEL.md ───────────────────────────────────────
    const pricingModelMd = `---
schema: agentagencies/v1
doctype: pricing-model
slug: hourly-450
name: Hourly 450 EUR
details:
  kind: hourly
  rate: 450
  currency: EUR
  capHours: 200
---

# Hourly 450 EUR
`
    await writeFile(
      "pricing-models/hourly-450/PRICING-MODEL.md",
      pricingModelMd
    )
    expect(validatePricingModel(pricingModelMd).ok).toBe(true)

    // ─── 4. PROCEDURE.md ────────────────────────────────────────────
    const procedureMd = `---
schema: agentagencies/v1
doctype: procedure
slug: design-project-execute
name: Design project execution
description: How a design engagement is executed.
triggers:
  - kind: service
    service: web-design
requiredSkills: [ui-design, ux-research]
estimatedDuration: P14D
steps:
  - id: scope
    description: Capture requirements
    requiredSkill: ux-research
    output: ENGAGEMENT.md
  - id: design
    description: Produce design v1
    requiredSkill: ui-design
    output: DELIVERABLE.md
  - id: review
    branch:
      - if: feedback_provided
        action: revise
      - else: true
        action: requestSignaturesTool
---

# Design project execution

Step-by-step playbook.
`
    await writeFile(
      "procedures/design-project-execute/PROCEDURE.md",
      procedureMd
    )
    expect(validateProcedure(procedureMd).ok).toBe(true)

    // ─── 5. COUNTERPARTY.md ─────────────────────────────────────────
    const counterpartyMd = `---
schema: agentagencies/v1
doctype: counterparty
slug: acme-corp
name: Acme Corp.
kind: organization
displayName: Acme Corp.
primaryEmail: signing@acme.example
country: FR
currency: EUR
timezone: Europe/Paris
channels:
  - kind: email
    address: signing@acme.example
    isPrimary: true
    optInAt: 2026-01-01T00:00:00.000Z
source: manual
tags: [enterprise]
---

# Acme Corp.
`
    await writeFile("counterparties/acme-corp/COUNTERPARTY.md", counterpartyMd)
    expect(validateCounterparty(counterpartyMd).ok).toBe(true)

    // ─── 6. ENGAGEMENT.md ───────────────────────────────────────────
    const engagementMd = `---
schema: agentagencies/v1
doctype: engagement
slug: 2026-acme-website
name: Acme website redesign
kind: milestone
status: in_progress
parties:
  - role: client
    party: counterparty:acme-corp
  - role: agency
    party: operator:jeremy
primaryCounterpartyId: acme-corp
serviceSlug: web-design
activeProcedure: design-project-execute
activeStep: scope
agreementPath: AGREEMENT.md
totalContractValue: 12000
currency: EUR
scopedAt: 2026-04-01T10:00:00.000Z
startedAt: 2026-04-05T10:00:00.000Z
---

# Acme website redesign engagement

Scope kickoff complete; in execution.
`
    await writeFile("engagements/2026-acme-website/ENGAGEMENT.md", engagementMd)
    expect(validateEngagement(engagementMd).ok).toBe(true)

    // ─── 7. AGREEMENT.md ────────────────────────────────────────────
    const agreementMd = `---
schema: agentagencies/v1
doctype: agreement
slug: 2026-acme-website
name: Web design SoW
kind: agreement
status: proposed
parties:
  - role: client
    party: counterparty:acme-corp
  - role: agency
    party: operator:jeremy
primaryCounterpartyId: acme-corp
lineItems:
  - lineItemId: 11111111-1111-4111-8111-111111111111
    description: Discovery + scope
    quantity: 1
    unitAmount: 2000
    currency: EUR
  - lineItemId: 22222222-2222-4222-8222-222222222222
    description: Design v1 + iterations
    quantity: 1
    unitAmount: 10000
    currency: EUR
currency: EUR
totalAmount: 12000
paymentTerms:
  netDuration: P30D
  schedule: milestone
requiredSignatures:
  - signer: counterparty:acme-corp
    method: typed_name
  - signer: operator:jeremy
    method: agent_confirm
governingLaw: French law
jurisdiction: Paris, France
version: "1"
---

# Web design SoW

Scope: design v1 + 2 iterations.
`
    await writeFile("engagements/2026-acme-website/AGREEMENT.md", agreementMd)
    expect(validateAgreement(agreementMd).ok).toBe(true)

    // ─── 8. Cross-doctype consistency ───────────────────────────────
    const ws: AgenciesWorkspaceFiles = {
      services: new Map([
        [
          "web-design",
          (validateService(serviceMd) as unknown as { ok: true; value: never })
            .value,
        ],
      ]),
      procedures: new Map([
        [
          "design-project-execute",
          (
            validateProcedure(procedureMd) as unknown as {
              ok: true
              value: never
            }
          ).value,
        ],
      ]),
      pricingModels: new Map([
        [
          "hourly-450",
          (
            validatePricingModel(pricingModelMd) as unknown as {
              ok: true
              value: never
            }
          ).value,
        ],
      ]),
      counterparties: new Map([
        [
          "acme-corp",
          (
            validateCounterparty(counterpartyMd) as unknown as {
              ok: true
              value: never
            }
          ).value,
        ],
      ]),
      engagements: new Map([
        [
          "2026-acme-website",
          (
            validateEngagement(engagementMd) as unknown as {
              ok: true
              value: never
            }
          ).value,
        ],
      ]),
      agreements: new Map([
        [
          "2026-acme-website",
          (
            validateAgreement(agreementMd) as unknown as {
              ok: true
              value: never
            }
          ).value,
        ],
      ]),
    }
    const consistencyErrors = checkAgenciesConsistency(ws)
    expect(consistencyErrors).toEqual([])

    // ─── 9. Counterparty signs the agreement (typed_name) ──────────
    const r1 = await signArtifact(governance, {
      artifactPath: "engagements/2026-acme-website/AGREEMENT.md",
      signer: "counterparty:acme-corp",
      signerKind: "counterparty",
      signerEmail: "signing@acme.example",
      method: "typed_name",
      evidence: {
        kind: "typed_name",
        signerName: "Jane Doe",
        ipAddress: "203.0.113.5",
        userAgent: "Mozilla/5.0 (test)",
        nonce: "n_acme_001",
      },
      idempotencyKey: "e2e-sig-acme-001",
    })
    expect(r1.signature.signer).toBe("counterparty:acme-corp")
    expect(r1.auditLogPath).toBe(
      "engagements/2026-acme-website/audit/audit-log.jsonl"
    )

    // ─── 10. Agent signs the agreement (agent_confirm) ─────────────
    const r2 = await signArtifact(governance, {
      artifactPath: "engagements/2026-acme-website/AGREEMENT.md",
      signer: "operator:jeremy",
      signerKind: "operator",
      method: "agent_confirm",
      evidence: {
        kind: "agent_confirm",
        modelId: "claude-sonnet-4-6",
        promptContextHash: "f".repeat(64),
        reasoningSummary: "Signing as agency principal; SoW reviewed.",
        conversationTurnId: "turn_e2e_001",
      },
      idempotencyKey: "e2e-sig-jeremy-001",
    })
    expect(r2.signature.signer).toBe("operator:jeremy")

    // ─── 11. Verify the audit chain end-to-end ─────────────────────
    const logContent = await readFile(
      "engagements/2026-acme-website/audit/audit-log.jsonl"
    )
    const verify = validateAuditLog(logContent, {
      secret: SECRET,
      genesisSeed: GENESIS,
    })
    expect(verify.ok).toBe(true)
    if (verify.ok) {
      // Two signatures recorded as `signature.created`.
      expect(verify.value.events).toHaveLength(2)
      expect(verify.value.events[0]!.action).toBe("signature.created")
      expect(verify.value.events[1]!.action).toBe("signature.created")
      expect(verify.value.chain.ok).toBe(true)
    }

    // ─── 12. Both signatures persisted as files ────────────────────
    const sigDir = path.join(
      tmpRoot,
      "engagements/2026-acme-website/signatures"
    )
    const sigs = await fs.readdir(sigDir)
    expect(sigs.length).toBe(2)
    expect(sigs.some(s => s.startsWith("counterparty-acme-corp-"))).toBe(true)
    expect(sigs.some(s => s.startsWith("operator-jeremy-"))).toBe(true)

    // ─── 13. Workspace exports cleanly (frontmatter parses) ────────
    // Anyone receiving the engagement folder as a tarball can re-validate.
    const exportedAgreement = await readFile(
      "engagements/2026-acme-website/AGREEMENT.md"
    )
    const parsed = matter(exportedAgreement)
    expect(parsed.data.slug).toBe("2026-acme-website")

    // ─── 14. Record an engagement.status_changed audit event ───────
    const statusChange = await recordAuditEvent(governance, {
      scopeDir: "engagements/2026-acme-website/audit",
      actorKind: "agent",
      actorId: "jeremy",
      entityType: "engagement",
      entityId: "engagements/2026-acme-website/ENGAGEMENT.md",
      action: "engagement.status_changed",
      payload: { from: "in_progress", to: "signed" },
      idempotencyKey: "e2e-status-001",
    })
    expect(statusChange.lineIndex).toBe(2)

    // Final chain still verifies after the status-change event.
    const finalLog = await readFile(
      "engagements/2026-acme-website/audit/audit-log.jsonl"
    )
    const finalVerify = validateAuditLog(finalLog, {
      secret: SECRET,
      genesisSeed: GENESIS,
    })
    expect(finalVerify.ok).toBe(true)
    if (finalVerify.ok) {
      expect(finalVerify.value.events).toHaveLength(3)
      expect(finalVerify.value.events[2]!.action).toBe(
        "engagement.status_changed"
      )
    }
  }, 30000)
})
