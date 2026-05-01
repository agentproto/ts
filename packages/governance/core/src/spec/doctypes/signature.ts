import { z } from "zod"

/**
 * agentgovernance/v1 — `signature.json` doctype.
 *
 * Universal approval primitive. Every approval — of an agreement, deliverable,
 * invoice, policy override, agent-issued action, etc. — is a signature on an
 * artifact, recorded as a `<artifact-path>/../signatures/<signer>-<isoDate>.signature.json`
 * file alongside the artifact being signed.
 *
 * One file = one signature event. Signatures are append-only; revocation
 * writes a new file (or updates `revokedAt` if same signer re-issues).
 */

export const SIGNER_KIND = [
  "operator",
  "user",
  "counterparty",
  "agent",
  "external",
] as const
export const signerKindSchema = z.enum(SIGNER_KIND)
export type SignerKind = z.infer<typeof signerKindSchema>

export const SIGNING_METHOD = [
  "typed_name", // human types name + nonce on a tokenized portal page
  "agent_confirm", // agent records explicit confirmation with model + reasoning evidence
  "click_through", // single-click confirmation from a signed URL
  "esign_external", // DocuSeal / HelloSign / etc.; signed PDF archived alongside
] as const
export const signingMethodSchema = z.enum(SIGNING_METHOD)
export type SigningMethod = z.infer<typeof signingMethodSchema>

/** Evidence shapes per method. Must be consistent with top-level `method`. */
const typedNameEvidenceSchema = z.object({
  kind: z.literal("typed_name"),
  signerName: z.string().min(1),
  ipAddress: z.string(),
  userAgent: z.string(),
  nonce: z.string(),
  signedUrlToken: z.string().optional(),
})

const agentConfirmEvidenceSchema = z.object({
  kind: z.literal("agent_confirm"),
  modelId: z.string(),
  promptContextHash: z.string(),
  reasoningSummary: z.string().optional(),
  conversationTurnId: z.string().optional(),
  // For agent signing under policy: which POLICY.md authorized this signature?
  authorizedByPolicy: z.string().optional(),
})

const clickThroughEvidenceSchema = z.object({
  kind: z.literal("click_through"),
  ipAddress: z.string(),
  userAgent: z.string(),
  signedUrlToken: z.string(),
})

const esignExternalEvidenceSchema = z.object({
  kind: z.literal("esign_external"),
  provider: z.string(), // e.g., "docuseal", "hellosign"
  externalRef: z.string(), // provider envelope/document id
  signedPdfRef: z.string().optional(), // workspace-relative path to archived PDF
})

export const evidenceSchema = z.discriminatedUnion("kind", [
  typedNameEvidenceSchema,
  agentConfirmEvidenceSchema,
  clickThroughEvidenceSchema,
  esignExternalEvidenceSchema,
])
export type SignatureEvidence = z.infer<typeof evidenceSchema>

/** SHA-256 hex string (64 chars). */
const sha256HexSchema = z.string().regex(/^[a-f0-9]{64}$/, {
  message: "Expected lowercase hex SHA-256 (64 chars)",
})

/**
 * Signer identifier in canonical form `<kind>:<slug>`.
 *
 * Examples:
 *   operator:jeremy
 *   counterparty:acme-corp
 *   agent:ai-paralegal
 *   user:6f9e3a12
 *   external:contractor-bob
 */
const signerIdSchema = z
  .string()
  .regex(/^(operator|user|counterparty|agent|external):[a-z0-9][a-z0-9-]*$/, {
    message:
      "Expected '<kind>:<slug>' (slug lowercase, alphanumeric + hyphens)",
  })

export const signatureSchema = z
  .object({
    schema: z.literal("agentgovernance/v1"),
    doctype: z.literal("signature"),

    /** Canonical "<kind>:<slug>" identifier of the signer. */
    signer: signerIdSchema,
    signerKind: signerKindSchema,
    signerEmail: z.email().optional(),

    /**
     * Workspace-relative path to the artifact being signed (e.g.,
     * `engagements/2026-acme/AGREEMENT.md`). Allows verifiers to locate the
     * artifact without relying on file-system layout heuristics.
     */
    artifactPath: z.string().min(1),

    /** SHA-256 of the artifact bytes at signing time. */
    documentHash: sha256HexSchema,

    method: signingMethodSchema,
    evidence: evidenceSchema,

    signedAt: z.iso.datetime(),

    /** Revocation: append-only field set on a subsequent rewrite. */
    revokedAt: z.iso.datetime().optional(),
    revokedReason: z.string().optional(),

    /** Vendor-specific extensions allowed under metadata.<vendor>.* */
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .refine(sig => sig.method === sig.evidence.kind, {
    message: "evidence.kind must match top-level method",
  })

export type Signature = z.infer<typeof signatureSchema>

/** Filename helper: `<signer-kind>-<signer-slug>-<isoDate>.signature.json` */
export function signatureFilename(signer: string, signedAt: string): string {
  const slug = signer.replace(/:/g, "-")
  const date = signedAt.split("T")[0] ?? signedAt
  return `${slug}-${date}.signature.json`
}
