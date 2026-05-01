/**
 * Renderer wrapper for the `governance.signing-portal` canvakit template.
 *
 * The template is a self-contained HTML page that presents a `typed_name`
 * signing form. The host application is responsible for:
 *   1. Resolving the artifact + computing its SHA-256 documentHash.
 *   2. Generating a one-time nonce + signing URL.
 *   3. Receiving the form POST + writing the signature.json via
 *      @agentproto/governance `signArtifact` runtime helper.
 *
 * This module does NOT call canvakit directly — it just exposes the template
 * id, the variable schema, and a builder helper. Apps wire it to their canvakit
 * renderer (e.g., @canvakit/core).
 */

import { z } from "zod"

export const SIGNING_PORTAL_TEMPLATE_ID = "governance.signing-portal" as const

/** Path to the bundled .canvakit.html template (relative to the package root). */
export const SIGNING_PORTAL_TEMPLATE_PATH =
  "src/spec/canvakit-templates/governance.signing-portal/template.canvakit.html" as const

export const signingPortalVariablesSchema = z.object({
  /** Workspace-relative path to the artifact being signed. */
  artifactPath: z.string().min(1),
  /** Human-readable title to display (e.g., agreement title). */
  artifactTitle: z.string().min(1),
  /** Optional short excerpt of the artifact body (rendered above the form). */
  artifactExcerpt: z.string().optional(),
  /** SHA-256 hex of the artifact bytes; same value gets stored in signature.json. */
  documentHash: z.string().regex(/^[a-f0-9]{64}$/),
  /** Canonical signer kind (operator, user, counterparty, agent, external). */
  signerKind: z.enum(["operator", "user", "counterparty", "agent", "external"]),
  /** Canonical signer slug (without the `<kind>:` prefix). */
  signerSlug: z.string().min(1),
  /** Pre-filled name (if known); leave blank for a fresh portal session. */
  signerName: z.string().optional(),
  signerEmail: z.email().optional(),
  /** One-shot nonce token; signing endpoint MUST validate + invalidate on submit. */
  nonce: z.string().min(1),
  /** URL the form POSTs to. The endpoint receives a form-encoded body. */
  signUrl: z.string().min(1),
  /** Optional agency / company name shown in the lead paragraph. */
  agencyName: z.string().optional(),
})
export type SigningPortalVariables = z.infer<
  typeof signingPortalVariablesSchema
>

/** Build the variable bag for the canvakit template, applying defaults for absent fields. */
export function signingPortalVariables(
  input: SigningPortalVariables
): Record<string, string> {
  // canvakit's mustache engine treats undefined / "" identically for falsy
  // sections; we coerce optional fields to "".
  return {
    artifactPath: input.artifactPath,
    artifactTitle: input.artifactTitle,
    artifactExcerpt: input.artifactExcerpt ?? "",
    documentHash: input.documentHash,
    signerKind: input.signerKind,
    signerSlug: input.signerSlug,
    signerName: input.signerName ?? "",
    signerEmail: input.signerEmail ?? "",
    nonce: input.nonce,
    signUrl: input.signUrl,
    agencyName: input.agencyName ?? "",
  }
}
