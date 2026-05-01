/**
 * Renderer wrapper for the `agency.invoice-pdf` canvakit template.
 *
 * Unlike the engagement dashboard, this template has no live data sources —
 * the host application reads INVOICE.md (+ ENGAGEMENT.md / AGENCY.md /
 * COUNTERPARTY.md) and passes a flattened variable bag in. The result is
 * print-ready HTML; downstream PDF tooling (Chromium / wkhtmltopdf) renders
 * it. The frozen PDF is archived alongside the .md and signed.
 */

import { z } from "zod"

export const INVOICE_PDF_TEMPLATE_ID = "agency.invoice-pdf" as const

export const INVOICE_PDF_TEMPLATE_PATH =
  "src/spec/canvakit-templates/agency.invoice-pdf/template.canvakit.html" as const

const moneyFormattedSchema = z.string().regex(/^-?\d+(\.\d{1,4})?$/, {
  message:
    "Expected a numeric string (e.g. '1234.56'). Format the locale separately.",
})

const lineItemSchema = z.object({
  description: z.string().min(1),
  quantity: z.union([z.number(), z.string()]),
  unitPriceFormatted: moneyFormattedSchema,
  totalFormatted: moneyFormattedSchema,
})

const taxLineSchema = z.object({
  label: z.string().min(1),
  amountFormatted: moneyFormattedSchema,
})

export const invoicePdfVariablesSchema = z.object({
  agencyName: z.string().min(1),
  /** Allowed-HTML block (sender address). The renderer trusts this — sanitize upstream. */
  agencyAddressHtml: z.string().optional(),
  agencyTaxId: z.string().optional(),

  invoiceNumber: z.string().min(1),
  /** ISO date (YYYY-MM-DD). */
  issuedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  dueAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  /** "issued" | "paid" | "overdue" | "void" — pill-rendered. */
  status: z.string().min(1),

  counterpartyDisplayName: z.string().min(1),
  counterpartyAddressHtml: z.string().optional(),
  counterpartyTaxId: z.string().optional(),

  /** ISO 4217 (e.g. "EUR", "USD"). */
  currency: z.string().regex(/^[A-Z]{3}$/),

  subtotalFormatted: moneyFormattedSchema,
  taxLines: z.array(taxLineSchema).default([]),
  totalFormatted: moneyFormattedSchema,
  amountDueFormatted: moneyFormattedSchema,

  paymentTermsHtml: z.string().optional(),
  notesHtml: z.string().optional(),
  paymentLinkUrl: z.string().optional(),

  lineItems: z.array(lineItemSchema).min(1),
})
export type InvoicePdfVariables = z.infer<typeof invoicePdfVariablesSchema>

export function invoicePdfVariables(
  input: InvoicePdfVariables
): Record<string, unknown> {
  return {
    agencyName: input.agencyName,
    agencyAddressHtml: input.agencyAddressHtml ?? "",
    agencyTaxId: input.agencyTaxId ?? "",
    invoiceNumber: input.invoiceNumber,
    issuedAt: input.issuedAt,
    dueAt: input.dueAt,
    status: input.status,
    counterpartyDisplayName: input.counterpartyDisplayName,
    counterpartyAddressHtml: input.counterpartyAddressHtml ?? "",
    counterpartyTaxId: input.counterpartyTaxId ?? "",
    currency: input.currency,
    subtotalFormatted: input.subtotalFormatted,
    taxLines: input.taxLines,
    totalFormatted: input.totalFormatted,
    amountDueFormatted: input.amountDueFormatted,
    paymentTermsHtml: input.paymentTermsHtml ?? "",
    notesHtml: input.notesHtml ?? "",
    paymentLinkUrl: input.paymentLinkUrl ?? "",
    lineItems: input.lineItems,
  }
}
