import { z } from "zod"
import {
  countryIsoSchema,
  currencyIsoSchema,
  envelope,
  isoDatetimeOrDateSchema,
  kebabSlugSchema,
  timezoneSchema,
} from "./_common.js"

/**
 * agentagencies/v1 — `COUNTERPARTY.md` doctype.
 *
 * External party (client) — display name, primary channels, country/currency/timezone,
 * references to encrypted PII blob, mergedIntoId for dedup.
 *
 * Counterparties are NOT users / operators / agents. They live outside the
 * platform; all interactions are via channels (email, WhatsApp, SMS).
 */

export const COUNTERPARTY_KIND = ["individual", "organization"] as const
export const counterpartyKindSchema = z.enum(COUNTERPARTY_KIND)

export const COUNTERPARTY_SOURCE = [
  "manual",
  "inbound_email",
  "imported",
  "api",
] as const
export const counterpartySourceSchema = z.enum(COUNTERPARTY_SOURCE)

const counterpartyChannelSchema = z.object({
  kind: z.enum(["email", "whatsapp", "sms"]),
  address: z.string(), // normalized: lowercased email / E.164 phone
  isPrimary: z.boolean().default(false),
  verifiedAt: isoDatetimeOrDateSchema.optional(),
  optInAt: isoDatetimeOrDateSchema.optional(),
  optOutAt: isoDatetimeOrDateSchema.optional(),
  optOutReason: z.string().optional(),
  bouncedAt: isoDatetimeOrDateSchema.optional(),
  bounceReason: z.string().optional(),
})

export const counterpartyFrontmatterSchema = z.object({
  ...envelope("counterparty"),

  kind: counterpartyKindSchema,
  /** Display name (NOT the legal name; legal name lives in encrypted PII). */
  displayName: z.string().min(1),
  /** Pre-resolved primary email (denorm of channels[isPrimary, kind=email]). */
  primaryEmail: z.email().optional(),
  /** Pre-resolved primary phone in E.164 (denorm of channels[isPrimary, kind=whatsapp|sms]). */
  primaryPhone: z.string().optional(),

  channels: z.array(counterpartyChannelSchema).default([]),

  country: countryIsoSchema.optional(),
  currency: currencyIsoSchema.optional(),
  timezone: timezoneSchema.optional(),

  source: counterpartySourceSchema.default("manual"),

  /**
   * Path to encrypted PII blob (e.g., legal name, address, taxId, DOB).
   * The blob is encrypted at rest with a workspace-level key; only `displayName`
   * + `primaryEmail` + `primaryPhone` are unencrypted (for inbound channel routing).
   */
  piiBlobRef: z.string().optional(),

  /** Self-FK for dedup: this counterparty is merged into another (canonical) one. */
  mergedIntoId: kebabSlugSchema.optional(),

  /** Free-form tags for segmentation (e.g., ["enterprise", "newsletter-2026"]). */
  tags: z.array(z.string()).default([]),
})
export type CounterpartyFrontmatter = z.infer<
  typeof counterpartyFrontmatterSchema
>

export interface Counterparty {
  frontmatter: CounterpartyFrontmatter
  body: string
}

export const COUNTERPARTY_FILENAME = "COUNTERPARTY.md" as const
