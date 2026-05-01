/**
 * End-to-end test for `computeAgencyOverview`: walks a real on-disk
 * fixture workspace, projects the snapshot, validates the shape, and
 * asserts the headline aggregates are correct.
 *
 * Uses NodeGovernanceFilesystem (the default) — no Mastra wiring required.
 */

import { describe, it, expect } from "vitest"
import { promises as fs } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import { computeAgencyOverview } from "./compute-agency-overview.js"
import { agencyOverviewSnapshotSchema } from "@agentproto/agencies/renderers"

async function writeFile(absPath: string, content: string) {
  await fs.mkdir(path.dirname(absPath), { recursive: true })
  await fs.writeFile(absPath, content, "utf8")
}

async function buildFixtureWorkspace(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agency-overview-test-"))

  // 1 counterparty — Acme Corp
  await writeFile(
    path.join(root, "counterparties/acme-corp/COUNTERPARTY.md"),
    `---
schema: agentagencies/v1
doctype: counterparty
slug: acme-corp
displayName: Acme Corp
status: active
---

# Acme Corp
`
  )

  // 1 active engagement (signed) + AGREEMENT.md with a 1000 EUR total
  await writeFile(
    path.join(root, "engagements/2026-acme-redesign/ENGAGEMENT.md"),
    `---
schema: agentagencies/v1
doctype: engagement
slug: 2026-acme-redesign
name: Acme website redesign
status: signed
activeStep: execute
counterpartyId: acme-corp
createdAt: ${new Date().toISOString()}
---

# Acme website redesign
`
  )
  await writeFile(
    path.join(root, "engagements/2026-acme-redesign/AGREEMENT.md"),
    `---
schema: agentagencies/v1
doctype: agreement
totalAmount: 1000
currency: EUR
---

# Agreement
`
  )

  // 1 paid invoice (this calendar month → counts toward MRR)
  await writeFile(
    path.join(
      root,
      "engagements/2026-acme-redesign/invoices/inv-2026-0001/INVOICE.md"
    ),
    `---
schema: agentagencies/v1
doctype: invoice
invoiceNumber: INV-2026-0001
totalAmount: 600
currency: EUR
status: paid
issuedAt: ${new Date().toISOString()}
paidAt: ${new Date().toISOString()}
---

# Invoice
`
  )

  // 1 pipeline engagement (negotiating, 4000 EUR pipeline value)
  await writeFile(
    path.join(root, "engagements/2026-beta-launch/ENGAGEMENT.md"),
    `---
schema: agentagencies/v1
doctype: engagement
slug: 2026-beta-launch
name: Beta launch
status: negotiating
counterpartyId: acme-corp
---

# Beta launch
`
  )
  await writeFile(
    path.join(root, "engagements/2026-beta-launch/AGREEMENT.md"),
    `---
schema: agentagencies/v1
doctype: agreement
totalAmount: 4000
currency: EUR
---

# Agreement
`
  )

  // 1 closed engagement (should not count as active)
  await writeFile(
    path.join(root, "engagements/2025-old-project/ENGAGEMENT.md"),
    `---
schema: agentagencies/v1
doctype: engagement
slug: 2025-old-project
name: Old project
status: closed
counterpartyId: acme-corp
---

# Old project
`
  )

  // Pending signatures index
  await writeFile(
    path.join(root, "_index/pending-signatures.json"),
    JSON.stringify(
      {
        version: "1",
        updatedAt: new Date().toISOString(),
        bySigner: {
          "operator:founder": [
            {
              artifactPath: "engagements/2026-beta-launch/AGREEMENT.md",
              requestedAt: new Date(
                Date.now() - 3 * 24 * 60 * 60 * 1000
              ).toISOString(),
            },
          ],
        },
      },
      null,
      2
    )
  )

  return root
}

describe("computeAgencyOverview", () => {
  it("walks a fixture workspace + emits a valid snapshot with correct aggregates", async () => {
    const root = await buildFixtureWorkspace()
    try {
      const result = await computeAgencyOverview({
        config: { workspaceRoot: root },
      })

      // Schema-valid
      const parsed = agencyOverviewSnapshotSchema.safeParse(result.snapshot)
      expect(parsed.success).toBe(true)

      // Headline aggregates
      expect(result.snapshot.activeEngagementsCount).toBe(2) // signed + negotiating
      expect(result.snapshot.pendingSignaturesCount).toBe(1)
      expect(result.snapshot.pipelineValueFormatted).toBe("4,000.00") // 4000 EUR negotiating
      expect(result.snapshot.mrrFormatted).toBe("600.00") // 600 EUR paid this month
      expect(result.snapshot.byStatus.length).toBe(3) // signed, negotiating, closed
      expect(result.snapshot.recentPayments.length).toBe(1)
      expect(result.snapshot.recentPayments[0]?.invoiceNumber).toBe(
        "INV-2026-0001"
      )
      expect(result.snapshot.pendingByEngagement.length).toBe(1)
      expect(result.snapshot.pendingByEngagement[0]?.slug).toBe(
        "2026-beta-launch"
      )

      // Walk counts
      expect(result.walked.engagements).toBe(3)
      expect(result.walked.counterparties).toBe(1)
      expect(result.walked.invoices).toBe(1)
      expect(result.walked.skipped).toBe(0)

      // Snapshot was written
      expect(result.snapshotPath).toBe("_snapshots/agency-overview.json")
      const written = JSON.parse(
        await fs.readFile(
          path.join(root, "_snapshots/agency-overview.json"),
          "utf8"
        )
      )
      expect(written.activeEngagementsCount).toBe(2)
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it("write:false skips the snapshot file", async () => {
    const root = await buildFixtureWorkspace()
    try {
      const result = await computeAgencyOverview({
        config: { workspaceRoot: root },
        write: false,
      })
      expect(result.snapshotPath).toBeNull()
      const exists = await fs
        .access(path.join(root, "_snapshots/agency-overview.json"))
        .then(() => true)
        .catch(() => false)
      expect(exists).toBe(false)
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it("returns zero counts on an empty workspace without throwing", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "agency-overview-empty-")
    )
    try {
      const result = await computeAgencyOverview({
        config: { workspaceRoot: root },
        write: false,
      })
      expect(result.snapshot.activeEngagementsCount).toBe(0)
      expect(result.snapshot.pendingSignaturesCount).toBe(0)
      expect(result.walked.engagements).toBe(0)
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it("ships canonical ROUTINE.md + PROCEDURE.md snippets at known paths", async () => {
    // Snippets live in the sibling @agentproto/agencies package — the runtime
    // walker writes outputs that the canvakit template (also in core) reads,
    // so the canonical .md files stay co-located with the spec.
    const corePackageRoot = path.resolve(__dirname, "..", "..", "core")
    const routinePath = path.join(
      corePackageRoot,
      "src/spec/snippets/agency-overview-rollup/routines/agency-overview-rollup/ROUTINE.md"
    )
    const procedurePath = path.join(
      corePackageRoot,
      "src/spec/snippets/agency-overview-rollup/procedures/compute-agency-overview/PROCEDURE.md"
    )
    const routine = await fs.readFile(routinePath, "utf8")
    const procedure = await fs.readFile(procedurePath, "utf8")
    expect(routine).toContain("schema: agentagencies/v1")
    expect(routine).toContain("doctype: routine")
    expect(routine).toContain("slug: agency-overview-rollup")
    expect(routine).toContain('cronExpression: "*/10 * * * *"')
    expect(procedure).toContain("schema: agentagencies/v1")
    expect(procedure).toContain("doctype: procedure")
    expect(procedure).toContain("slug: compute-agency-overview")
  })
})
