import { describe, it, expect } from "vitest"
import {
  agencyFrontmatterSchema,
  serviceFrontmatterSchema,
  procedureFrontmatterSchema,
  pricingModelFrontmatterSchema,
  counterpartyFrontmatterSchema,
  engagementFrontmatterSchema,
  agreementFrontmatterSchema,
  deliverableFrontmatterSchema,
  invoiceFrontmatterSchema,
  routineFrontmatterSchema,
  capacityFrontmatterSchema,
  operationsFrontmatterSchema,
} from "./index.js"

describe("agencyFrontmatterSchema", () => {
  it("accepts a minimal AGENCY.md", () => {
    const fm = {
      schema: "agentagencies/v1",
      doctype: "agency",
      slug: "acme-plumbing",
      name: "Acme Plumbing",
    }
    expect(agencyFrontmatterSchema.safeParse(fm).success).toBe(true)
  })

  it("accepts a full AGENCY.md profile", () => {
    const fm = {
      schema: "agentagencies/v1",
      doctype: "agency",
      slug: "acme-plumbing",
      name: "Acme Plumbing",
      verticals: ["plumbing-callout"],
      primaryServices: ["emergency-callout", "drain-cleaning"],
      defaultPricingModel: "hourly-rate",
      defaultCurrency: "EUR",
      billingTimezone: "Europe/Paris",
      fiscalYearStart: "2026-01-01",
      autonomyPosture: "hybrid",
      includes: ["./services/", "./pricing-models/"],
      metadata: { agency: { taxId: "FR-XXX" } },
    }
    expect(agencyFrontmatterSchema.safeParse(fm).success).toBe(true)
  })

  it("rejects invalid autonomy posture", () => {
    const fm = {
      schema: "agentagencies/v1",
      doctype: "agency",
      slug: "x",
      name: "x",
      autonomyPosture: "yolo",
    }
    expect(agencyFrontmatterSchema.safeParse(fm).success).toBe(false)
  })
})

describe("serviceFrontmatterSchema", () => {
  it("accepts a service with default procedure + pricing", () => {
    const fm = {
      schema: "agentagencies/v1",
      doctype: "service",
      slug: "emergency-callout",
      name: "Emergency callout",
      requiredSkills: ["diagnose-leak", "dispatch"],
      defaultProcedure: "emergency-plumbing-callout",
      defaultPricingModel: "fixed-callout",
      estimatedDuration: "PT2H",
      tags: ["plumbing", "emergency"],
    }
    expect(serviceFrontmatterSchema.safeParse(fm).success).toBe(true)
  })
})

describe("procedureFrontmatterSchema", () => {
  it("accepts a multi-step procedure", () => {
    const fm = {
      schema: "agentagencies/v1",
      doctype: "procedure",
      slug: "emergency-plumbing-callout",
      name: "Emergency plumbing callout",
      triggers: [{ kind: "service", service: "emergency-callout" }],
      requiredSkills: ["diagnose-leak", "dispatch", "billing"],
      estimatedDuration: "PT2H",
      autonomyPolicy: "invoice-cap-200eur",
      steps: [
        {
          id: "triage",
          description: "Take the call",
          requiredSkill: "dispatch",
          output: "TASK.md",
        },
        {
          id: "diagnose",
          requiredSkill: "diagnose-leak",
          output: "DELIVERABLE.md",
        },
        {
          id: "decide",
          branch: [
            { if: "estimate < cap", action: "proceed_repair" },
            { else: true, action: "requestSignaturesTool" },
          ],
        },
      ],
    }
    expect(procedureFrontmatterSchema.safeParse(fm).success).toBe(true)
  })

  it("requires at least one step", () => {
    const fm = {
      schema: "agentagencies/v1",
      doctype: "procedure",
      slug: "x",
      name: "x",
      steps: [],
    }
    expect(procedureFrontmatterSchema.safeParse(fm).success).toBe(false)
  })
})

describe("pricingModelFrontmatterSchema", () => {
  it("accepts a hourly model with cap", () => {
    const fm = {
      schema: "agentagencies/v1",
      doctype: "pricing-model",
      slug: "hourly-450",
      name: "Hourly 450 EUR",
      details: { kind: "hourly", rate: 450, currency: "EUR", capHours: 200 },
    }
    expect(pricingModelFrontmatterSchema.safeParse(fm).success).toBe(true)
  })

  it("accepts a milestone model", () => {
    const fm = {
      schema: "agentagencies/v1",
      doctype: "pricing-model",
      slug: "design-3-milestones",
      name: "Design 3 milestones",
      details: {
        kind: "milestone",
        currency: "EUR",
        milestones: [
          { slug: "kickoff", amount: 5000 },
          { slug: "midpoint", amount: 10000 },
          { slug: "final", amount: 5000 },
        ],
      },
    }
    expect(pricingModelFrontmatterSchema.safeParse(fm).success).toBe(true)
  })
})

describe("counterpartyFrontmatterSchema", () => {
  it("accepts a counterparty with channels", () => {
    const fm = {
      schema: "agentagencies/v1",
      doctype: "counterparty",
      slug: "acme-corp",
      name: "Acme Corp.",
      kind: "organization",
      displayName: "Acme Corp.",
      primaryEmail: "billing@acme.example",
      country: "FR",
      currency: "EUR",
      timezone: "Europe/Paris",
      channels: [
        {
          kind: "email",
          address: "billing@acme.example",
          isPrimary: true,
          optInAt: "2026-01-01T00:00:00.000Z",
        },
      ],
      source: "manual",
    }
    expect(counterpartyFrontmatterSchema.safeParse(fm).success).toBe(true)
  })
})

describe("engagementFrontmatterSchema", () => {
  it("accepts an engagement with active procedure tracking", () => {
    const fm = {
      schema: "agentagencies/v1",
      doctype: "engagement",
      slug: "2026-acme-website",
      name: "Acme website redesign",
      kind: "milestone",
      status: "in_progress",
      parties: [
        { role: "client", party: "counterparty:acme-corp" },
        { role: "executor", party: "operator:jeremy" },
      ],
      primaryCounterpartyId: "acme-corp",
      serviceSlug: "web-design",
      activeProcedure: "design-project-execute",
      activeStep: "v1-mockups",
      pricingModelSlug: "design-3-milestones",
      totalContractValue: 20000,
      currency: "EUR",
    }
    expect(engagementFrontmatterSchema.safeParse(fm).success).toBe(true)
  })
})

describe("agreementFrontmatterSchema", () => {
  it("accepts a signed agreement", () => {
    const fm = {
      schema: "agentagencies/v1",
      doctype: "agreement",
      slug: "2026-acme-website",
      name: "Web design SoW",
      kind: "agreement",
      status: "signed",
      parties: [
        { role: "client", party: "counterparty:acme-corp" },
        { role: "agency", party: "operator:jeremy" },
      ],
      primaryCounterpartyId: "acme-corp",
      lineItems: [
        {
          lineItemId: "550e8400-e29b-41d4-a716-446655440000",
          description: "Web design v1",
          quantity: 1,
          unitAmount: 5000,
          currency: "EUR",
        },
      ],
      currency: "EUR",
      totalAmount: 5000,
      requiredSignatures: [
        { signer: "counterparty:acme-corp", method: "typed_name" },
        { signer: "operator:jeremy", method: "typed_name" },
      ],
      signedAt: "2026-04-15T10:00:00.000Z",
      version: "1",
    }
    expect(agreementFrontmatterSchema.safeParse(fm).success).toBe(true)
  })

  it("requires at least 2 parties", () => {
    const fm = {
      schema: "agentagencies/v1",
      doctype: "agreement",
      slug: "x",
      name: "x",
      kind: "quote",
      parties: [{ role: "x", party: "operator:x" }],
      primaryCounterpartyId: "x",
      currency: "EUR",
    }
    expect(agreementFrontmatterSchema.safeParse(fm).success).toBe(false)
  })
})

describe("invoiceFrontmatterSchema", () => {
  it("accepts a full invoice with tax + Stripe linkage", () => {
    const fm = {
      schema: "agentagencies/v1",
      doctype: "invoice",
      slug: "inv-2026-00042",
      name: "Invoice 42",
      invoiceNumber: "INV-2026-00042",
      counterpartyId: "acme-corp",
      engagementSlug: "2026-acme-website",
      lineItems: [
        {
          lineItemId: "550e8400-e29b-41d4-a716-446655440000",
          description: "Milestone 1",
          quantity: 1,
          unitAmount: 5000,
        },
      ],
      taxLines: [
        { rate: 0.2, base: 5000, amount: 1000, jurisdiction: "FR-VAT" },
      ],
      subtotal: 5000,
      taxTotal: 1000,
      total: 6000,
      currency: "EUR",
      status: "issued",
      issuedAt: "2026-04-15T10:00:00.000Z",
      dueAt: "2026-05-15T10:00:00.000Z",
      externalRefs: { stripe: { paymentIntentId: "pi_test123" } },
    }
    expect(invoiceFrontmatterSchema.safeParse(fm).success).toBe(true)
  })
})

describe("deliverableFrontmatterSchema", () => {
  it("accepts a deliverable with attachments + required signatures", () => {
    const fm = {
      schema: "agentagencies/v1",
      doctype: "deliverable",
      slug: "v1-mockups",
      name: "v1 mockups",
      status: "submitted",
      attachments: [
        { path: "engagements/x/attachments/v1/mockup.pdf", kind: "pdf" },
      ],
      requiredSignatures: [
        { signer: "counterparty:acme-corp", method: "typed_name" },
      ],
    }
    expect(deliverableFrontmatterSchema.safeParse(fm).success).toBe(true)
  })
})

describe("routineFrontmatterSchema", () => {
  it("accepts a scheduled routine pointing at a procedure", () => {
    const fm = {
      schema: "agentagencies/v1",
      doctype: "routine",
      slug: "monthly-retainer-invoice",
      name: "Monthly retainer invoice",
      runs: "issue-monthly-retainer-invoice",
      trigger: {
        kind: "schedule",
        cronExpression: "0 9 1 * *",
        timezone: "Europe/Paris",
      },
      enabled: true,
    }
    expect(routineFrontmatterSchema.safeParse(fm).success).toBe(true)
  })
})

describe("capacityFrontmatterSchema", () => {
  it("accepts a capacity entry with availability + specializations", () => {
    const fm = {
      schema: "agentagencies/v1",
      doctype: "capacity",
      slug: "plumber-jane",
      name: "Plumber Jane",
      for: "operator:plumber-jane",
      availability: [
        { weekday: "mon", start: "08:00", end: "18:00" },
        { weekday: "tue", start: "08:00", end: "18:00" },
      ],
      maxConcurrentEngagements: 5,
      specializations: ["emergency-callout", "drain-cleaning"],
    }
    expect(capacityFrontmatterSchema.safeParse(fm).success).toBe(true)
  })
})

describe("operationsFrontmatterSchema", () => {
  it("accepts an external ops package root", () => {
    const fm = {
      schema: "agentagencies/v1",
      doctype: "operations",
      slug: "plumbing-division-ops",
      name: "Plumbing Division Operations",
      version: "1.0.0",
      authors: [{ name: "Big Corp." }],
      includes: ["./services/", "./pricing-models/"],
    }
    expect(operationsFrontmatterSchema.safeParse(fm).success).toBe(true)
  })
})
