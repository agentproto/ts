/**
 * BILLING.md parser and manifest-to-handle constructor (AIP-74).
 *
 * `parseBillingManifest` reads the file and checks its SHAPE with the zod
 * schema derived from `BILLING.schema.json`. `billingFromManifest` then runs
 * `defineBillingManifest`, which checks the cross-reference rules and derives
 * the rates and edges, so the file and the TypeScript path end in the same
 * validators (BILL-PARSE).
 */
import matter from "gray-matter"
import { billingFrontmatterSchema, type BillingFrontmatter } from "../schema.js"
import {
  defineBillingManifest,
  type BillingHandle,
  type DefineBillingManifestOptions,
} from "../define-billing-manifest.js"
import type { BillingDefinition } from "../types.js"

export { billingFrontmatterSchema, type BillingFrontmatter }

export interface BillingManifest {
  frontmatter: BillingFrontmatter
  body: string
}

export function parseBillingManifest(source: string): BillingManifest {
  const parsed = matter(source)
  if (Object.keys(parsed.data).length === 0) {
    throw new Error("parseBillingManifest (AIP-74): missing or empty frontmatter")
  }
  const result = billingFrontmatterSchema.safeParse(parsed.data)
  if (!result.success) {
    throw new Error(
      `parseBillingManifest (AIP-74): invalid frontmatter: ${result.error.issues
        .map(i => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`,
    )
  }
  return { frontmatter: result.data, body: parsed.content }
}

export function billingFromManifest(
  manifest: BillingManifest,
  opts?: DefineBillingManifestOptions,
): BillingHandle {
  return defineBillingManifest(manifest.frontmatter as unknown as BillingDefinition, opts)
}

/** Read a BILLING.md and return its validated handle. */
export function loadBillingManifest(source: string, opts?: DefineBillingManifestOptions): BillingHandle {
  return billingFromManifest(parseBillingManifest(source), opts)
}
