import { z } from "zod"
import {
  currencyIsoSchema,
  envelope,
  isoDatetimeOrDateSchema,
  kebabSlugSchema,
  sha256HexSchema,
} from "./_common.js"

/**
 * agentagencies/v1 — `INVOICE.md` doctype.
 *
 * Invoice issued to a counterparty. Carries line items, tax lines, totals,
 * FX (when invoice currency differs from billing-account base), payment status,
 * and `externalRefs.<provider>` for payment provider linkage (Stripe checkout
 * sessions, payment intents, etc.).
 *
 * Invoice numbering is per-tenant gapless (driven by `_state/invoice-sequence.json`
 * file-lock pattern in the runtime layer; format like `INV-YYYY-NNNNN`).
 */

export const INVOICE_STATUS = [
  "draft",
  "issued",
  "paid",
  "void",
  "uncollectible",
] as const
export const invoiceStatusSchema = z.enum(INVOICE_STATUS)
export type InvoiceStatus = z.infer<typeof invoiceStatusSchema>

const lineItemSchema = z.object({
  lineItemId: z.uuid(),
  description: z.string().min(1),
  quantity: z.number().positive().default(1),
  unitAmount: z.number().nonnegative(),
  /** Reference to the originating engagement deliverable / agreement line item. */
  sourceRef: z.string().optional(),
})

const taxLineSchema = z.object({
  /** Decimal rate (e.g., 0.20 for 20% VAT). */
  rate: z.number().min(0).max(1),
  /** Base amount taxed. */
  base: z.number().nonnegative(),
  /** Computed tax amount. */
  amount: z.number().nonnegative(),
  /** Jurisdiction code (e.g., "FR-VAT", "US-CA-SALES"). */
  jurisdiction: z.string(),
})

const externalRefsSchema = z.record(
  z.string(),
  z.record(z.string(), z.string()).optional()
)

export const invoiceFrontmatterSchema = z.object({
  ...envelope("invoice"),

  status: invoiceStatusSchema.default("draft"),

  /** Per-tenant gapless invoice number (e.g., INV-2026-00042). */
  invoiceNumber: z.string().min(1),

  /** Workspace-relative path to the engagement folder. */
  engagementSlug: kebabSlugSchema.optional(),
  agreementSlug: kebabSlugSchema.optional(),
  counterpartyId: kebabSlugSchema,
  billingAccountId: kebabSlugSchema.optional(),

  lineItems: z.array(lineItemSchema).min(1),
  taxLines: z.array(taxLineSchema).default([]),

  subtotal: z.number().nonnegative(),
  taxTotal: z.number().nonnegative().default(0),
  total: z.number().nonnegative(),
  currency: currencyIsoSchema,

  /** FX snapshot — used when invoice currency != billing-account base currency. */
  fxRate: z.number().positive().optional(),
  fxBaseCurrency: currencyIsoSchema.optional(),
  fxAt: isoDatetimeOrDateSchema.optional(),

  dueAt: isoDatetimeOrDateSchema.optional(),
  issuedAt: isoDatetimeOrDateSchema.optional(),
  paidAt: isoDatetimeOrDateSchema.optional(),
  voidedAt: isoDatetimeOrDateSchema.optional(),
  voidReason: z.string().optional(),

  /** Storage ref for the rendered immutable PDF. */
  pdfBlobRef: z.string().optional(),
  /** SHA-256 of the rendered PDF. */
  pdfHash: sha256HexSchema.optional(),

  /** Provider-specific linkage — Stripe payment intent id, paypal capture id, etc. */
  externalRefs: externalRefsSchema.optional(),

  /** Public payment link (set after `issueInvoiceCheckoutTool` runs). */
  paymentLinkUrl: z.string().optional(),

  /** Dunning state for retainer/late invoices. */
  dunningState: z
    .enum(["none", "reminder_1", "reminder_2", "final_notice", "collections"])
    .default("none"),
  nextReminderAt: isoDatetimeOrDateSchema.optional(),
})
export type InvoiceFrontmatter = z.infer<typeof invoiceFrontmatterSchema>

export interface Invoice {
  frontmatter: InvoiceFrontmatter
  body: string
}

export const INVOICE_FILENAME = "INVOICE.md" as const
