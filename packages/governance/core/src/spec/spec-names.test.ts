import { describe, it, expect } from "vitest"

import { signatureSchema } from "./doctypes/signature.js"
import { auditEventSchema } from "./doctypes/audit-event.js"
import { policyFrontmatterSchema } from "./doctypes/policy.js"
import {
  validateAuditEvent,
  validateAuditLog,
  validatePolicy,
  validateSignature,
} from "./validators/index.js"
import { chainRow } from "./hash-chain/compute.js"
import { verifyChain } from "./hash-chain/verify.js"
import { parsePolicyManifest } from "../policy/index.js"

const GENESIS = "0".repeat(64)
const SECRET = "spec-names-test-secret"

const BASE_SIGNATURE = {
  doctype: "signature",
  signer: "operator:jeremy",
  signerKind: "operator",
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
} as const

function auditRow(schema: string): Record<string, unknown> {
  return {
    schema,
    doctype: "audit-event",
    actorKind: "system",
    actorId: null,
    entityType: "audit-event",
    entityId: "test:genesis",
    action: "log.initialized",
    createdAt: "2026-04-15T10:23:45.000Z",
  }
}

const POLICY_SOURCE = (schema: string) => `---
schema: ${schema}
doctype: policy
slug: invoice-cap-500eur
name: Invoice cap 500 EUR
---

# Invoice cap
`

describe("AIP-70 spec names on read paths", () => {
  it("signatureSchema accepts the AIP-70 governance/v1 tag", () => {
    const result = signatureSchema.safeParse({
      ...BASE_SIGNATURE,
      schema: "governance/v1",
    })
    expect(result.success).toBe(true)
  })

  it("signatureSchema still accepts the legacy agentgovernance/v1 tag", () => {
    const result = signatureSchema.safeParse({
      ...BASE_SIGNATURE,
      schema: "agentgovernance/v1",
    })
    expect(result.success).toBe(true)
  })

  it("auditEventSchema accepts the AIP-70 governance/v1 tag", () => {
    const row = chainRow(auditRow("governance/v1"), GENESIS, SECRET)
    expect(auditEventSchema.safeParse(row).success).toBe(true)
  })

  it("auditEventSchema still accepts the legacy agentgovernance/v1 tag", () => {
    const row = chainRow(auditRow("agentgovernance/v1"), GENESIS, SECRET)
    expect(auditEventSchema.safeParse(row).success).toBe(true)
  })

  it("policyFrontmatterSchema accepts the AIP-70 governance/v1 tag", () => {
    const parsed = parsePolicyManifest(POLICY_SOURCE("governance/v1"))
    expect(parsed.frontmatter.schema).toBe("governance/v1")
  })

  it("policyFrontmatterSchema still accepts the legacy agentgovernance/v1 tag", () => {
    const parsed = parsePolicyManifest(POLICY_SOURCE("agentgovernance/v1"))
    expect(parsed.frontmatter.schema).toBe("agentgovernance/v1")
  })

  it("validateSignature accepts governance/v1 and rejects unknown tags", () => {
    expect(
      validateSignature(
        JSON.stringify({ ...BASE_SIGNATURE, schema: "governance/v1" }),
      ).ok,
    ).toBe(true)
    expect(
      validateSignature(
        JSON.stringify({ ...BASE_SIGNATURE, schema: "agentgovernance/v2" }),
      ).ok,
    ).toBe(false)
  })

  it("validateAuditEvent accepts governance/v1 rows", () => {
    const row = chainRow(auditRow("governance/v1"), GENESIS, SECRET)
    expect(validateAuditEvent(JSON.stringify(row)).ok).toBe(true)
  })

  it("validatePolicy accepts a governance/v1 POLICY.md", () => {
    const result = validatePolicy(POLICY_SOURCE("governance/v1"))
    expect(result.ok).toBe(true)
  })

  it("verifyChain uses the schema tag stored in the row, not a re-derived one", () => {
    // The tag is part of the hashed bytes. A chain whose rows carry
    // governance/v1 must verify from the stored rows alone.
    const row1 = chainRow(auditRow("governance/v1"), GENESIS, SECRET)
    const row2 = chainRow(
      { ...auditRow("governance/v1"), action: "test.next" },
      row1.signature,
      SECRET,
    )
    const jsonl = `${JSON.stringify(row1)}\n${JSON.stringify(row2)}\n`
    const result = verifyChain(jsonl, { secret: SECRET, genesisSeed: GENESIS })
    expect(result.ok).toBe(true)
  })

  it("validateAuditLog accepts a governance/v1 chain end-to-end", () => {
    const row1 = chainRow(auditRow("governance/v1"), GENESIS, SECRET)
    const row2 = chainRow(
      { ...auditRow("governance/v1"), action: "test.next" },
      row1.signature,
      SECRET,
    )
    const jsonl = `${JSON.stringify(row1)}\n${JSON.stringify(row2)}\n`
    const result = validateAuditLog(jsonl, {
      secret: SECRET,
      genesisSeed: GENESIS,
    })
    expect(result.ok).toBe(true)
  })

  it("validateAuditLog still accepts a legacy agentgovernance/v1 chain", () => {
    const row1 = chainRow(auditRow("agentgovernance/v1"), GENESIS, SECRET)
    const jsonl = `${JSON.stringify(row1)}\n`
    const result = validateAuditLog(jsonl, {
      secret: SECRET,
      genesisSeed: GENESIS,
    })
    expect(result.ok).toBe(true)
  })
})
