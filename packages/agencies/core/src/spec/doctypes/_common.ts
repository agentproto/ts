import { z } from "zod"

/**
 * Shared zod primitives used across agentagencies/v1 doctypes.
 * Aligned with companies.sh + governance.sh conventions.
 */

export const SCHEMA_NAME = "agentagencies/v1" as const

/** Lowercase slug: `^[a-z0-9][a-z0-9-]*$` */
export const kebabSlugSchema = z.string().regex(/^[a-z0-9][a-z0-9-]*$/, {
  message:
    "Expected kebab-case slug (lowercase, alphanumeric + hyphens, leading alphanumeric)",
})

/** ISO 4217 3-letter currency code (e.g., EUR, USD, GBP). */
export const currencyIsoSchema = z.string().length(3, {
  message: "Expected ISO 4217 3-letter currency code",
})

/** ISO 3166 2-letter country code (e.g., FR, US, DE). */
export const countryIsoSchema = z.string().length(2, {
  message: "Expected ISO 3166 2-letter country code",
})

/** IANA timezone (e.g., Europe/Paris, America/New_York). */
export const timezoneSchema = z.string().min(1)

/** ISO-8601 duration: P, PT, P1Y2M3DT4H5M6S, etc. */
export const isoDurationSchema = z.string().regex(/^P/, {
  message: "Expected ISO-8601 duration starting with 'P'",
})

/**
 * ISO-8601 date string OR a YAML-parsed Date object (gray-matter / js-yaml
 * auto-parses `YYYY-MM-DD` literals to Date). Normalizes to "YYYY-MM-DD" string.
 */
export const isoDateOrDateSchema = z.union([
  z.iso.date(),
  z.date().transform(d => d.toISOString().slice(0, 10)),
])

/**
 * ISO-8601 datetime string OR a YAML-parsed Date. YAML 1.1 auto-parses
 * `YYYY-MM-DDTHH:MM:SS(.fff)?(Z|+/-HH:MM)?` literals to Date — the schema
 * accepts both forms and normalizes to ISO datetime string.
 */
export const isoDatetimeOrDateSchema = z.union([
  z.iso.datetime(),
  z.date().transform(d => d.toISOString()),
])

/** Party reference in canonical "<kind>:<slug>" form, with wildcard `*` allowed. */
export const partyRefSchema = z
  .string()
  .regex(
    /^(operator|user|counterparty|agent|external|team):([a-z0-9][a-z0-9-]*|\*)$/,
    { message: "Expected '<kind>:<slug>' or '<kind>:*'" }
  )

/** Strict slug-only party ref (no wildcard). */
export const partyRefStrictSchema = z
  .string()
  .regex(
    /^(operator|user|counterparty|agent|external|team):[a-z0-9][a-z0-9-]*$/,
    { message: "Expected '<kind>:<slug>'" }
  )

/** Workspace-relative path (forward slashes, no leading slash, no `..`). */
export const workspacePathSchema = z
  .string()
  .min(1)
  .refine(p => !p.startsWith("/"), {
    message: "Expected relative path (no leading /)",
  })
  .refine(p => !p.includes(".."), { message: "Path must not contain '..'" })

/** Vendor metadata bag — `metadata.<vendor>.*` for extensions. */
export const metadataSchema = z.record(z.string(), z.unknown())

/** SHA-256 hex string (64 chars). */
export const sha256HexSchema = z.string().regex(/^[a-f0-9]{64}$/, {
  message: "Expected lowercase hex SHA-256 (64 chars)",
})

/** Common authorship + provenance fields shared across doctypes. */
export const authorshipFields = {
  authors: z
    .array(
      z.object({
        name: z.string().min(1),
        email: z.email().optional(),
        url: z.string().optional(),
      })
    )
    .optional(),
  homepage: z.string().optional(),
  tags: z.array(z.string()).optional(),
}

/** Common doctype envelope — schema + doctype literal + slug + name + description. */
export function envelope<DocType extends string>(doctype: DocType) {
  return {
    schema: z.literal(SCHEMA_NAME),
    doctype: z.literal(doctype),
    slug: kebabSlugSchema,
    name: z.string().min(1),
    description: z.string().optional(),
    version: z.string().optional(), // semver, optional per agentcompanies convention
    metadata: metadataSchema.optional(),
  } as const
}
