/**
 * Renderer wrapper for the `agency.agreement-signing` canvakit template.
 *
 * Multi-party signing portal for AGREEMENT.md. Differs from
 * governance.signing-portal by rendering the agreement body, line items, and
 * the multi-party signature status alongside the typed-name form.
 */

import { z } from "zod"

export const AGREEMENT_SIGNING_TEMPLATE_ID = "agency.agreement-signing" as const

export const AGREEMENT_SIGNING_TEMPLATE_PATH =
  "src/spec/canvakit-templates/agency.agreement-signing/template.canvakit.html" as const

const moneyFormattedSchema = z
  .string()
  .regex(/^-?\d+(\.\d{1,4})?$/, "Expected a numeric string (e.g. '1234.56')")

const lineItemSchema = z.object({
  description: z.string().min(1),
  quantity: z.union([z.number(), z.string()]),
  totalFormatted: moneyFormattedSchema,
})

const partySchema = z.object({
  /** Display label like "Acme Corp (counterparty)". */
  label: z.string().min(1),
  /** ISO timestamp (already-signed) or ISO deadline (pending). */
  signedAt: z.string().optional(),
  deadline: z.string().optional(),
})

export const agreementSigningVariablesSchema = z.object({
  agencyName: z.string().min(1),
  agreementTitle: z.string().min(1),
  agreementPath: z.string().min(1),
  /** Pre-rendered HTML of the agreement body (markdown → HTML upstream). */
  agreementBodyHtml: z.string().optional(),
  documentHash: z.string().regex(/^[a-f0-9]{64}$/),
  signerKind: z.enum(["operator", "user", "counterparty", "agent", "external"]),
  signerSlug: z.string().min(1),
  signerName: z.string().optional(),
  signerEmail: z.email().optional(),
  nonce: z.string().min(1),
  signUrl: z.string().min(1),

  /** Parties who have already signed (rendered in the "Already signed" panel). */
  alreadySignedParties: z.array(partySchema).default([]),
  /** Parties still pending (rendered in the "Pending signatures" panel). */
  pendingParties: z.array(partySchema).default([]),

  lineItems: z.array(lineItemSchema).default([]),
  totalFormatted: moneyFormattedSchema.default("0.00"),
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/)
    .default("EUR"),
  paymentTermsHtml: z.string().optional(),
})
export type AgreementSigningVariables = z.infer<
  typeof agreementSigningVariablesSchema
>

export function agreementSigningVariables(
  input: AgreementSigningVariables
): Record<string, unknown> {
  return {
    agencyName: input.agencyName,
    agreementTitle: input.agreementTitle,
    agreementPath: input.agreementPath,
    agreementBodyHtml: input.agreementBodyHtml ?? "",
    documentHash: input.documentHash,
    signerKind: input.signerKind,
    signerSlug: input.signerSlug,
    signerName: input.signerName ?? "",
    signerEmail: input.signerEmail ?? "",
    nonce: input.nonce,
    signUrl: input.signUrl,
    alreadySignedParties: input.alreadySignedParties,
    pendingParties: input.pendingParties,
    lineItems: input.lineItems,
    totalFormatted: input.totalFormatted,
    currency: input.currency,
    paymentTermsHtml: input.paymentTermsHtml ?? "",
  }
}
