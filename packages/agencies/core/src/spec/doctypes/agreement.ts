import { z } from "zod"
import {
  currencyIsoSchema,
  envelope,
  isoDatetimeOrDateSchema,
  isoDurationSchema,
  kebabSlugSchema,
  partyRefStrictSchema,
  sha256HexSchema,
} from "./_common.js"

/**
 * agentagencies/v1 — `AGREEMENT.md` doctype.
 *
 * Contract for an engagement. Carries parties, line items, payment terms,
 * deliverable spec, governing law, and a `requiredSignatures` field that
 * defers to agentgovernance/v1.
 *
 * Once `status === "signed"`, the artifact is effectively immutable — the
 * runtime layer enforces this via "create new version, supersede" semantics.
 */

export const AGREEMENT_KIND = ["quote", "agreement"] as const
export const agreementKindSchema = z.enum(AGREEMENT_KIND)
export type AgreementKind = z.infer<typeof agreementKindSchema>

export const AGREEMENT_STATUS = [
  "draft",
  "proposed",
  "signed",
  "superseded",
  "expired",
  "void",
  "cancelled",
] as const
export const agreementStatusSchema = z.enum(AGREEMENT_STATUS)
export type AgreementStatus = z.infer<typeof agreementStatusSchema>

const agreementPartySchema = z.object({
  role: z.string().min(1),
  party: partyRefStrictSchema,
  share: z.number().min(0).max(100).optional(),
})

const lineItemSchema = z.object({
  /** Stable UUID for the line item — survives revisions. */
  lineItemId: z.uuid(),
  description: z.string().min(1),
  quantity: z.number().positive().default(1),
  unitAmount: z.number().nonnegative(),
  currency: currencyIsoSchema,
  /** When this line item triggers payment (used by milestone pricing). */
  paymentTrigger: z.string().optional(),
})

const paymentTermsSchema = z.object({
  /** ISO-8601 duration: net payment window after invoice (e.g., PT0H, P15D, P30D). */
  netDuration: isoDurationSchema.default("P30D"),
  /** Schedule kind: at signature, on milestones, monthly retainer, etc. */
  schedule: z
    .enum(["at_signature", "milestone", "retainer", "on_completion", "custom"])
    .default("on_completion"),
  /** Late fee terms — free-form for v1. */
  latePolicy: z.string().optional(),
})

/** Required-signatures shape — matches agentgovernance/v1.requiredSignatures. */
const requiredSignerSchema = z.object({
  signer: partyRefStrictSchema,
  method: z.enum([
    "typed_name",
    "agent_confirm",
    "click_through",
    "esign_external",
  ]),
  weight: z.number().min(0).optional(),
})

export const agreementFrontmatterSchema = z.object({
  ...envelope("agreement"),

  kind: agreementKindSchema,
  status: agreementStatusSchema.default("draft"),

  parties: z.array(agreementPartySchema).min(2),
  /** Denormalized: primary counterparty for fast queries. */
  primaryCounterpartyId: kebabSlugSchema,

  lineItems: z.array(lineItemSchema).default([]),
  currency: currencyIsoSchema, // single currency per agreement (multi-currency = separate agreements)
  /** Denormalized total of lineItems[].quantity * unitAmount. */
  totalAmount: z.number().nonnegative().optional(),

  paymentTerms: paymentTermsSchema.default({
    netDuration: "P30D",
    schedule: "on_completion",
  }),

  /** Free-form deliverable spec (refers to DELIVERABLE.md slugs or describes inline). */
  deliverableSpec: z.unknown().optional(),

  /** Required signatures (defers to agentgovernance/v1 contractual approval framework). */
  requiredSignatures: z.array(requiredSignerSchema).default([]),

  /** Legal jurisdiction + governing law. */
  governingLaw: z.string().optional(),
  jurisdiction: z.string().optional(),

  /** Hash of the rendered SoW PDF (or canonical bytes if no PDF). Witness for the signature. */
  documentHash: sha256HexSchema.optional(),
  /** Storage ref for the rendered immutable PDF/document. */
  documentBlobRef: z.string().optional(),

  /** Versioning chain. */
  version: z.string().default("1"),
  /** Self-ref to the previous version's slug (when this agreement supersedes another). */
  parentAgreement: kebabSlugSchema.optional(),

  effectiveAt: isoDatetimeOrDateSchema.optional(),
  expiresAt: isoDatetimeOrDateSchema.optional(),
  signedAt: isoDatetimeOrDateSchema.optional(),
})
export type AgreementFrontmatter = z.infer<typeof agreementFrontmatterSchema>

export interface Agreement {
  frontmatter: AgreementFrontmatter
  body: string
}

export const AGREEMENT_FILENAME = "AGREEMENT.md" as const
