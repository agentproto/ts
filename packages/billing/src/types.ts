/** Types of the manifest, inferred from the zod schema so the two cannot disagree. */
import type { BillingFrontmatter } from "./schema.js"

export type BillingDefinition = BillingFrontmatter
export type Offer = NonNullable<BillingDefinition["offers"]>[number]
export type Conversion = NonNullable<BillingDefinition["conversions"]>[number]
export type Grant = NonNullable<BillingDefinition["grants"]>[number]
