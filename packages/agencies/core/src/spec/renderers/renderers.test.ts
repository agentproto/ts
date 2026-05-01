/**
 * Smoke test for the bundled canvakit templates: each template file
 * exists, parses as YAML+HTML frontmatter, and the variable schema
 * accepts a minimal valid input.
 */

import { describe, it, expect } from "vitest"
import { promises as fs } from "node:fs"
import * as path from "node:path"
import matter from "gray-matter"

import {
  ENGAGEMENT_DASHBOARD_TEMPLATE_ID,
  ENGAGEMENT_DASHBOARD_TEMPLATE_PATH,
  engagementDashboardVariablesSchema,
  INVOICE_PDF_TEMPLATE_ID,
  INVOICE_PDF_TEMPLATE_PATH,
  invoicePdfVariablesSchema,
  AGENCY_OVERVIEW_TEMPLATE_ID,
  AGENCY_OVERVIEW_TEMPLATE_PATH,
  agencyOverviewVariablesSchema,
  agencyOverviewSnapshotSchema,
  isAgencyOverviewSnapshotStale,
  AGREEMENT_SIGNING_TEMPLATE_ID,
  AGREEMENT_SIGNING_TEMPLATE_PATH,
  agreementSigningVariablesSchema,
  DELIVERABLE_REVIEW_TEMPLATE_ID,
  DELIVERABLE_REVIEW_TEMPLATE_PATH,
  deliverableReviewVariablesSchema,
  PROCEDURE_CARD_TEMPLATE_ID,
  PROCEDURE_CARD_TEMPLATE_PATH,
  procedureCardVariablesSchema,
  AGENCY_PROFILE_TEMPLATE_ID,
  AGENCY_PROFILE_TEMPLATE_PATH,
  agencyProfileVariablesSchema,
} from "./index.js"

const PACKAGE_ROOT = path.resolve(__dirname, "..", "..", "..")

async function loadTemplate(relPath: string) {
  const abs = path.resolve(PACKAGE_ROOT, relPath)
  const raw = await fs.readFile(abs, "utf8")
  const parsed = matter(raw)
  return { raw, frontmatter: parsed.data, body: parsed.content }
}

describe("agencies canvakit templates — bundled HTML files", () => {
  it("agency.engagement-dashboard parses + declares the right id + has live data sources", async () => {
    const t = await loadTemplate(ENGAGEMENT_DASHBOARD_TEMPLATE_PATH)
    expect(t.frontmatter.template).toBe(true)
    expect(t.frontmatter.name).toBe(ENGAGEMENT_DASHBOARD_TEMPLATE_ID)
    expect(t.frontmatter.refreshEvery).toBe("30s")
    expect(t.frontmatter.dataSources).toBeDefined()
    const ds = t.frontmatter.dataSources as {
      engagement: { kind: string }
      deliverables: { kind: string }
      invoices: { kind: string }
      audit: { kind: string }
    }
    expect(ds.engagement.kind).toBe("file")
    expect(ds.deliverables.kind).toBe("query")
    expect(ds.invoices.kind).toBe("query")
    expect(ds.audit.kind).toBe("tool")
    expect(t.body).toContain("<!doctype html>")
  })

  it("agency.invoice-pdf parses + declares the right id + has no live data sources", async () => {
    const t = await loadTemplate(INVOICE_PDF_TEMPLATE_PATH)
    expect(t.frontmatter.template).toBe(true)
    expect(t.frontmatter.name).toBe(INVOICE_PDF_TEMPLATE_ID)
    expect(t.frontmatter.dataSources).toEqual({})
    expect(t.body).toContain("Invoice")
    expect(t.body).toContain("@page")
  })

  it("agency.agency-overview parses + reads a single kind:file snapshot", async () => {
    const t = await loadTemplate(AGENCY_OVERVIEW_TEMPLATE_PATH)
    expect(t.frontmatter.template).toBe(true)
    expect(t.frontmatter.name).toBe(AGENCY_OVERVIEW_TEMPLATE_ID)
    expect(t.frontmatter.refreshEvery).toBe("5m")
    const ds = t.frontmatter.dataSources as {
      snapshot: { kind: string; path: string }
    }
    expect(ds.snapshot.kind).toBe("file")
    expect(ds.snapshot.path).toBe("_snapshots/agency-overview.json")
  })
})

describe("agencies canvakit templates — variable schemas", () => {
  it("engagement-dashboard schema validates a minimal payload", () => {
    const ok = engagementDashboardVariablesSchema.safeParse({
      engagementSlug: "2026-acme-website",
      agencyName: "Acme",
    })
    expect(ok.success).toBe(true)
  })

  it("engagement-dashboard schema rejects uppercase slugs", () => {
    const fail = engagementDashboardVariablesSchema.safeParse({
      engagementSlug: "Acme-Website",
      agencyName: "Acme",
    })
    expect(fail.success).toBe(false)
  })

  it("invoice-pdf schema accepts a minimal one-line invoice", () => {
    const ok = invoicePdfVariablesSchema.safeParse({
      agencyName: "Acme",
      invoiceNumber: "INV-2026-0001",
      issuedAt: "2026-04-26",
      dueAt: "2026-05-26",
      status: "issued",
      counterpartyDisplayName: "Beta Corp",
      currency: "EUR",
      subtotalFormatted: "100.00",
      totalFormatted: "120.00",
      amountDueFormatted: "120.00",
      lineItems: [
        {
          description: "Design phase 1",
          quantity: 1,
          unitPriceFormatted: "100.00",
          totalFormatted: "100.00",
        },
      ],
    })
    expect(ok.success).toBe(true)
  })

  it("invoice-pdf schema rejects an invoice with zero line items", () => {
    const fail = invoicePdfVariablesSchema.safeParse({
      agencyName: "Acme",
      invoiceNumber: "INV-2026-0001",
      issuedAt: "2026-04-26",
      dueAt: "2026-05-26",
      status: "issued",
      counterpartyDisplayName: "Beta Corp",
      currency: "EUR",
      subtotalFormatted: "0.00",
      totalFormatted: "0.00",
      amountDueFormatted: "0.00",
      lineItems: [],
    })
    expect(fail.success).toBe(false)
  })

  it("agency-overview schema validates the routine-populated snapshot shape", () => {
    const ok = agencyOverviewSnapshotSchema.safeParse({
      generatedAt: new Date().toISOString(),
      activeEngagementsCount: 3,
      pipelineValueFormatted: "12,400.00",
      mrrFormatted: "1,800.00",
      pendingSignaturesCount: 2,
    })
    expect(ok.success).toBe(true)
  })

  it("isAgencyOverviewSnapshotStale flags a snapshot older than the threshold", () => {
    const fresh = { generatedAt: new Date().toISOString() }
    const stale = {
      generatedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    }
    expect(isAgencyOverviewSnapshotStale(fresh)).toBe(false)
    expect(isAgencyOverviewSnapshotStale(stale)).toBe(true)
  })

  it("agency-overview variables schema accepts a minimal payload", () => {
    const ok = agencyOverviewVariablesSchema.safeParse({
      agencyName: "Acme",
      agencySlug: "acme",
    })
    expect(ok.success).toBe(true)
  })
})

describe("agencies canvakit templates — Phase 4 (signing + review + docs)", () => {
  const cases: Array<{ id: string; relPath: string; name: string }> = [
    {
      id: AGREEMENT_SIGNING_TEMPLATE_ID,
      relPath: AGREEMENT_SIGNING_TEMPLATE_PATH,
      name: "agency.agreement-signing",
    },
    {
      id: DELIVERABLE_REVIEW_TEMPLATE_ID,
      relPath: DELIVERABLE_REVIEW_TEMPLATE_PATH,
      name: "agency.deliverable-review",
    },
    {
      id: PROCEDURE_CARD_TEMPLATE_ID,
      relPath: PROCEDURE_CARD_TEMPLATE_PATH,
      name: "agency.procedure-card",
    },
    {
      id: AGENCY_PROFILE_TEMPLATE_ID,
      relPath: AGENCY_PROFILE_TEMPLATE_PATH,
      name: "agency.agency-profile",
    },
  ]

  for (const c of cases) {
    it(`${c.name} parses + frontmatter declares the right id`, async () => {
      const t = await loadTemplate(c.relPath)
      expect(t.frontmatter.template).toBe(true)
      expect(t.frontmatter.name).toBe(c.id)
      expect(t.body).toContain("<!doctype html>")
    })
  }

  it("agreement-signing variables schema accepts a minimal valid payload", () => {
    const ok = agreementSigningVariablesSchema.safeParse({
      agencyName: "Acme",
      agreementTitle: "Acme retainer",
      agreementPath: "engagements/2026-acme/AGREEMENT.md",
      documentHash: "a".repeat(64),
      signerKind: "counterparty",
      signerSlug: "acme-corp",
      nonce: "nonce-1",
      signUrl: "/sign",
    })
    expect(ok.success).toBe(true)
  })

  it("deliverable-review variables schema accepts a minimal valid payload", () => {
    const ok = deliverableReviewVariablesSchema.safeParse({
      agencyName: "Acme",
      deliverableTitle: "v1 mockups",
      deliverablePath: "engagements/2026-acme/deliverables/v1/DELIVERABLE.md",
      documentHash: "b".repeat(64),
      signerKind: "counterparty",
      signerSlug: "acme-corp",
      nonce: "nonce-2",
      signUrl: "/sign",
      reviseUrl: "/revise",
    })
    expect(ok.success).toBe(true)
  })

  it("procedure-card variables schema accepts a minimal valid payload", () => {
    const ok = procedureCardVariablesSchema.safeParse({
      procedurePath: "procedures/design-project-execute/PROCEDURE.md",
    })
    expect(ok.success).toBe(true)
  })

  it("agency-profile variables schema accepts a minimal valid payload", () => {
    const ok = agencyProfileVariablesSchema.safeParse({
      contactUrl: "/contact",
    })
    expect(ok.success).toBe(true)
  })
})
