import { describe, it, expect } from "vitest"
import { signatureSchema, signatureFilename } from "./signature.js"
import { auditEventSchema, parseAuditLine } from "./audit-event.js"
import { policyFrontmatterSchema } from "./policy.js"

describe("signatureSchema", () => {
  it("accepts a valid typed_name signature", () => {
    const sig = {
      schema: "agentgovernance/v1",
      doctype: "signature",
      signer: "operator:jeremy",
      signerKind: "operator",
      signerEmail: "jeremy@example.com",
      artifactPath: "engagements/2026-acme/AGREEMENT.md",
      documentHash: "a".repeat(64),
      method: "typed_name",
      evidence: {
        kind: "typed_name",
        signerName: "Jeremy",
        ipAddress: "192.0.2.1",
        userAgent: "Mozilla/5.0",
        nonce: "abc123",
      },
      signedAt: "2026-04-15T10:23:45.000Z",
    }
    expect(signatureSchema.safeParse(sig).success).toBe(true)
  })

  it("accepts a valid agent_confirm signature", () => {
    const sig = {
      schema: "agentgovernance/v1",
      doctype: "signature",
      signer: "agent:ai-paralegal",
      signerKind: "agent",
      artifactPath: "engagements/2026-acme/QUOTE.md",
      documentHash: "b".repeat(64),
      method: "agent_confirm",
      evidence: {
        kind: "agent_confirm",
        modelId: "claude-sonnet-4",
        promptContextHash: "c".repeat(64),
        reasoningSummary: "Cap policy satisfied; under 200 EUR.",
        authorizedByPolicy: "auto-approve-quotes-under-200eur",
      },
      signedAt: "2026-04-15T10:23:45.000Z",
    }
    expect(signatureSchema.safeParse(sig).success).toBe(true)
  })

  it("rejects evidence-method mismatch", () => {
    const sig = {
      schema: "agentgovernance/v1",
      doctype: "signature",
      signer: "operator:jeremy",
      signerKind: "operator",
      artifactPath: "x.md",
      documentHash: "a".repeat(64),
      method: "typed_name",
      evidence: {
        kind: "agent_confirm",
        modelId: "x",
        promptContextHash: "x".repeat(64),
      },
      signedAt: "2026-04-15T10:23:45.000Z",
    }
    expect(signatureSchema.safeParse(sig).success).toBe(false)
  })

  it("rejects malformed signer id", () => {
    const sig = {
      schema: "agentgovernance/v1",
      doctype: "signature",
      signer: "Jeremy", // no kind prefix
      signerKind: "operator",
      artifactPath: "x.md",
      documentHash: "a".repeat(64),
      method: "typed_name",
      evidence: {
        kind: "typed_name",
        signerName: "x",
        ipAddress: "x",
        userAgent: "x",
        nonce: "x",
      },
      signedAt: "2026-04-15T10:23:45.000Z",
    }
    expect(signatureSchema.safeParse(sig).success).toBe(false)
  })

  it("rejects non-hex documentHash", () => {
    const sig = {
      schema: "agentgovernance/v1",
      doctype: "signature",
      signer: "operator:jeremy",
      signerKind: "operator",
      artifactPath: "x.md",
      documentHash: "not-hex",
      method: "typed_name",
      evidence: {
        kind: "typed_name",
        signerName: "x",
        ipAddress: "x",
        userAgent: "x",
        nonce: "x",
      },
      signedAt: "2026-04-15T10:23:45.000Z",
    }
    expect(signatureSchema.safeParse(sig).success).toBe(false)
  })
})

describe("signatureFilename", () => {
  it("produces signer-kind-slug-date.signature.json", () => {
    expect(
      signatureFilename("operator:jeremy", "2026-04-15T10:23:45.000Z")
    ).toBe("operator-jeremy-2026-04-15.signature.json")
  })
})

describe("auditEventSchema", () => {
  it("accepts a valid event", () => {
    const evt = {
      schema: "agentgovernance/v1",
      doctype: "audit-event",
      actorKind: "operator",
      actorId: "jeremy",
      entityType: "signature",
      entityId: "engagements/x/sig.json",
      action: "signature.created",
      prevSignature: "a".repeat(64),
      signature: "b".repeat(64),
      createdAt: "2026-04-15T10:23:45.000Z",
    }
    expect(auditEventSchema.safeParse(evt).success).toBe(true)
  })

  it("rejects malformed action verb", () => {
    const evt = {
      schema: "agentgovernance/v1",
      doctype: "audit-event",
      actorKind: "system",
      actorId: null,
      entityType: "signature",
      entityId: "x",
      action: "Signature.Created", // uppercase + bad shape
      prevSignature: "a".repeat(64),
      signature: "b".repeat(64),
      createdAt: "2026-04-15T10:23:45.000Z",
    }
    expect(auditEventSchema.safeParse(evt).success).toBe(false)
  })
})

describe("parseAuditLine", () => {
  it("round-trips a line", () => {
    const evt = {
      schema: "agentgovernance/v1",
      doctype: "audit-event",
      actorKind: "system",
      actorId: null,
      entityType: "audit-event",
      entityId: "x",
      action: "log.initialized",
      prevSignature: "a".repeat(64),
      signature: "b".repeat(64),
      createdAt: "2026-04-15T10:23:45.000Z",
    }
    const line = JSON.stringify(evt)
    const parsed = parseAuditLine(line)
    expect(parsed.action).toBe("log.initialized")
  })
})

describe("policyFrontmatterSchema", () => {
  it("accepts a valid invoice-cap policy", () => {
    const p = {
      schema: "agentgovernance/v1",
      doctype: "policy",
      slug: "invoice-cap-500eur",
      name: "Invoice cap 500 EUR",
      appliesTo: [
        { actorKind: "operator", actionType: "agency.issue_invoice" },
      ],
      caps: [{ field: "amount", max: 500, currency: "EUR" }],
      threshold: "single",
      requiredSignatures: [
        { signer: "operator:founder", method: "typed_name" },
      ],
      deadline: "PT24H",
      escalation: { leadTime: "PT2H", escalateTo: ["operator:cofounder"] },
    }
    expect(policyFrontmatterSchema.safeParse(p).success).toBe(true)
  })

  it("requires requiredWeight when threshold is weighted_threshold", () => {
    const p = {
      schema: "agentgovernance/v1",
      doctype: "policy",
      slug: "x",
      name: "x",
      threshold: "weighted_threshold",
      requiredSignatures: [
        { signer: "operator:a", method: "typed_name", weight: 1 },
        { signer: "operator:b", method: "typed_name", weight: 1 },
      ],
    }
    expect(policyFrontmatterSchema.safeParse(p).success).toBe(false)

    const p2 = { ...p, requiredWeight: 2 }
    expect(policyFrontmatterSchema.safeParse(p2).success).toBe(true)
  })
})
