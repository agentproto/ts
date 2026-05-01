import * as path from "node:path"

import {
  signatureSchema,
  type Signature,
  type SignatureEvidence,
  type SignerKind,
  type SigningMethod,
  signatureFilename,
} from "@agentproto/governance/doctypes"
import {
  getFilesystem,
  resolveFromRoot,
  sha256Hex,
  toRelativePath,
} from "./fs.js"
import { recordAuditEvent } from "./audit-chain.js"
import type { GovernanceConfig } from "./workspace-config.js"

/**
 * `signArtifact` — write a signature.json file alongside an artifact and
 * append a hash-chained audit-log entry.
 *
 * The signing method's evidence shape MUST match the top-level method.
 * The document hash is ALWAYS computed from the artifact bytes on disk.
 * Callers MAY supply `expectedDocumentHash` to assert what they believe
 * the bytes are; if it doesn't match what we actually read, we reject.
 * This closes the forgery primitive in earlier drafts where a caller
 * could dictate the hash and produce a signature that didn't match the
 * underlying file.
 */

export interface SignArtifactInput {
  /** Workspace-relative path to the artifact being signed. */
  artifactPath: string
  /** Canonical signer "<kind>:<slug>" (e.g., `operator:jeremy`, `counterparty:acme-corp`). */
  signer: string
  signerKind: SignerKind
  signerEmail?: string
  method: SigningMethod
  evidence: SignatureEvidence
  /**
   * Optional caller-asserted document hash. When provided, MUST equal the
   * SHA-256 of the artifact bytes — otherwise `signArtifact` rejects.
   * The recorded `documentHash` is always the value computed from bytes,
   * never the caller-supplied assertion.
   */
  expectedDocumentHash?: string
  /** Override timestamp; default = now. */
  signedAt?: string
  /** Idempotency key (recorded in audit-log entry). */
  idempotencyKey?: string
  /** Vendor extensions under metadata.<vendor>.* */
  metadata?: Record<string, unknown>
}

export interface SignArtifactResult {
  signature: Signature
  /** Workspace-relative path to the signature.json file written. */
  signaturePath: string
  /** Audit log entry summary. */
  auditLogPath: string
  auditLineIndex: number
}

export async function signArtifact(
  config: GovernanceConfig,
  input: SignArtifactInput
): Promise<SignArtifactResult> {
  // 1. Validate evidence-method consistency upfront for a clearer error.
  if (input.evidence.kind !== input.method) {
    throw new Error(
      `signArtifact: evidence.kind '${input.evidence.kind}' must match method '${input.method}'`
    )
  }

  const fs = getFilesystem(config)

  // 2. Resolve artifact + compute documentHash from disk bytes.
  // The hash is ALWAYS what we actually read; an `expectedDocumentHash`
  // input acts only as an assertion, never as a substitute.
  const artifactAbs = resolveFromRoot(config.workspaceRoot, input.artifactPath)
  const artifactContent = await fs.readFile(artifactAbs)
  if (artifactContent == null) {
    throw new Error(`signArtifact: artifact not found at ${input.artifactPath}`)
  }
  const documentHash = sha256Hex(artifactContent)
  if (
    input.expectedDocumentHash !== undefined &&
    input.expectedDocumentHash !== documentHash
  ) {
    throw new Error(
      `signArtifact: expectedDocumentHash mismatch — caller asserted ${input.expectedDocumentHash} ` +
        `but artifact bytes hash to ${documentHash}. ` +
        `Either the artifact changed since the caller computed the hash, ` +
        `or the caller is signing the wrong content.`
    )
  }

  // 3. Compose the signature object.
  const signedAt = input.signedAt ?? new Date().toISOString()
  const sigObj: Signature = {
    schema: "agentgovernance/v1",
    doctype: "signature",
    signer: input.signer,
    signerKind: input.signerKind,
    ...(input.signerEmail !== undefined
      ? { signerEmail: input.signerEmail }
      : {}),
    artifactPath: input.artifactPath,
    documentHash,
    method: input.method,
    evidence: input.evidence,
    signedAt,
    ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
  } as Signature

  // 4. Validate against the zod schema.
  const parsed = signatureSchema.safeParse(sigObj)
  if (!parsed.success) {
    throw new Error(
      `signArtifact: produced an invalid signature — ${parsed.error.issues.map(i => i.message).join("; ")}`
    )
  }

  // 5. Write signature.json next to the artifact.
  const artifactDir = path.dirname(artifactAbs)
  const signaturesDir = path.join(artifactDir, "signatures")
  const filename = signatureFilename(input.signer, signedAt)
  const signaturePathAbs = path.join(signaturesDir, filename)
  await fs.ensureDir(signaturesDir)
  await fs.writeFileAtomic(
    signaturePathAbs,
    JSON.stringify(parsed.data, null, 2) + "\n"
  )

  // 6. Determine audit-log scope: same parent folder as the artifact for
  //    engagement-scoped logs; falls back to workspace-level otherwise.
  //    Heuristic: if artifact is under <something>/.../<x>/ANY.md, write to
  //    <something>/audit/audit-log.jsonl when that folder exists, else to
  //    workspace-level audit/audit-log.jsonl.
  //    Apps can override by passing `metadata.<vendor>.auditScopeDir`.
  const auditScopeDir = pickAuditScope(input)
  const audit = await recordAuditEvent(config, {
    scopeDir: auditScopeDir,
    actorKind:
      input.signerKind === "agent"
        ? "agent"
        : input.signerKind === "counterparty"
          ? "counterparty"
          : "operator",
    actorId: extractSlug(input.signer),
    entityType: "signature",
    entityId: toRelativePath(config.workspaceRoot, signaturePathAbs),
    action: "signature.created",
    payload: {
      method: input.method,
      artifactPath: input.artifactPath,
      documentHash,
    },
    idempotencyKey: input.idempotencyKey,
  })

  return {
    signature: parsed.data,
    signaturePath: toRelativePath(config.workspaceRoot, signaturePathAbs),
    auditLogPath: audit.logPath,
    auditLineIndex: audit.lineIndex,
  }
}

function extractSlug(signerId: string): string {
  const colon = signerId.indexOf(":")
  return colon === -1 ? signerId : signerId.slice(colon + 1)
}

function pickAuditScope(input: SignArtifactInput): string {
  // Heuristic: if artifactPath has the form "engagements/<slug>/...", use
  // "engagements/<slug>/audit". Otherwise use workspace-level "audit".
  const m = input.artifactPath.match(/^(engagements\/[^/]+)\//)
  return m ? `${m[1]}/audit` : "audit"
}
