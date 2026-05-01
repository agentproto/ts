/**
 * Renderer wrapper for the `agency.deliverable-review` canvakit template.
 *
 * Counterparty validation page — approve (typed-name signature) or request
 * revisions. Approval signs DELIVERABLE.md; revision request appends a
 * feedback comment + flips the engagement workflow back to `revise`.
 */

import { z } from "zod"

export const DELIVERABLE_REVIEW_TEMPLATE_ID =
  "agency.deliverable-review" as const

export const DELIVERABLE_REVIEW_TEMPLATE_PATH =
  "src/spec/canvakit-templates/agency.deliverable-review/template.canvakit.html" as const

const attachmentSchema = z.object({
  name: z.string().min(1),
  /** Human-friendly size like "1.2 MB" — formatted upstream. */
  sizeFormatted: z.string(),
  /** Free-form kind label rendered next to the size ("PDF", "Figma frame", …). */
  kind: z.string().optional(),
  /** URL to view/download the attachment. */
  url: z.string().min(1),
  /** Single-glyph icon (emoji or unicode). The template renders verbatim. */
  icon: z.string().default("📎"),
})

export const deliverableReviewVariablesSchema = z.object({
  agencyName: z.string().min(1),
  /** Optional engagement display name (rendered in the lead). */
  engagementName: z.string().optional(),
  deliverableTitle: z.string().min(1),
  deliverablePath: z.string().min(1),
  /** Markdown body rendered to HTML upstream (description + acceptance criteria). */
  deliverableBodyHtml: z.string().optional(),
  /** Free-form context shown above the body (e.g., "Phase 1 of 3"). */
  context: z.string().optional(),
  documentHash: z.string().regex(/^[a-f0-9]{64}$/),
  signerKind: z.enum(["operator", "user", "counterparty", "agent", "external"]),
  signerSlug: z.string().min(1),
  signerName: z.string().optional(),
  signerEmail: z.email().optional(),
  nonce: z.string().min(1),
  signUrl: z.string().min(1),
  reviseUrl: z.string().min(1),
  attachments: z.array(attachmentSchema).default([]),
})
export type DeliverableReviewVariables = z.infer<
  typeof deliverableReviewVariablesSchema
>

export function deliverableReviewVariables(
  input: DeliverableReviewVariables
): Record<string, unknown> {
  return {
    agencyName: input.agencyName,
    engagementName: input.engagementName ?? "",
    deliverableTitle: input.deliverableTitle,
    deliverablePath: input.deliverablePath,
    deliverableBodyHtml: input.deliverableBodyHtml ?? "",
    context: input.context ?? "",
    documentHash: input.documentHash,
    signerKind: input.signerKind,
    signerSlug: input.signerSlug,
    signerName: input.signerName ?? "",
    signerEmail: input.signerEmail ?? "",
    nonce: input.nonce,
    signUrl: input.signUrl,
    reviseUrl: input.reviseUrl,
    attachments: input.attachments,
  }
}
