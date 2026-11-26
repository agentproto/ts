/**
 * BILLING.md frontmatter zod schema (AIP-74).
 *
 * Mirrors `BILLING.schema.json` (agentproto/agentproto, AIP-74 draft). It is
 * written by hand, NOT emitted by `scripts/scaffold-aip.mjs`: the scaffolder
 * cannot render the draft's `if/then/else` rules (the offer and conversion
 * combinations) nor its external `$ref`s (the AIP-49 asset, the AIP-41
 * schedule), and its output for them does not type-check under zod 4. The two
 * cannot drift silently: `schema-conformance.test.ts` runs both on the same
 * documents (the four example files, and mutations of them) and requires the
 * same verdict. Switch to the scaffolder when the draft is vendored under
 * `specs/resources/aip-74/` and its `allOf` is expressible.
 *
 * The cross-REFERENCE rules (an unknown partition, a currency outside
 * anchor and fx) are not shape rules and live in `define-billing-manifest.ts`.
 */
import { z } from "zod"

const id = z.string().regex(/^[a-z][a-z0-9-]*$/)
const featureId = z.string().regex(/^[a-z][a-z0-9_-]*$/)
const railId = z.string().regex(/^[a-z][a-z0-9-]*$/)
const envName = z.string().regex(/^[A-Z][A-Z0-9_]*$/)
const currency = z.string().regex(/^[A-Za-z]{3}$/)
const assetRef = z.string().regex(/^(aip:\/\/49\/)?[A-Z][A-Z0-9_]*$/)
const fiatRef = /^(aip:\/\/49\/)?[A-Z]{3}$/
const partitionId = z.string().regex(/^[A-Z][A-Z0-9_]*:[A-Za-z0-9_-]+$/)
const duration = z
  .string()
  .regex(/^P(?=\d|T\d)(\d+Y)?(\d+M)?(\d+W)?(\d+D)?(T(?=\d)(\d+H)?(\d+M)?(\d+S)?)?$/)
const vendorStrategy = z.string().regex(/^x-[a-z][a-z0-9-]*:[a-z][a-z0-9-]*$/)

const expiry = z.union([
  z.object({ after: duration }).strict(),
  z.object({ atPeriodEnd: z.literal(true) }).strict(),
])

const restriction = z.array(z.string())
const timeSpec = z.any()
const partitionSpec = z
  .object({
    id: z.string().min(1),
    asset: z.string().min(1),
    restriction,
    spendableOn: z.array(z.string()).optional(),
    defaultTtlMs: z.number().gt(0).optional(),
    policy: z.array(z.any()).optional(),
  })
  .strict()
void timeSpec

const convertEdge = z.any()
const ruleSet = z
  .object({
    settleOut: z.union([z.literal(false), z.enum(["internal-ledger", "stripe", "pawapay", "x402", "solana"])]),
    spendableOn: z.array(z.string()),
    convertEdges: z.array(convertEdge),
    transfer: z.enum(["none", "internal", "external"]),
    custody: z.enum(["custodial-mirror", "on-chain-authority"]).optional(),
    settleIn: z.array(z.enum(["internal-ledger", "stripe", "pawapay", "x402", "solana"])).optional(),
  })
  .strict()

/** AIP-49 asset declaration (ASSET.schema.json), the inline form. */
const assetDeclaration = z
  .object({
    ref: z.string().regex(/^[A-Z0-9][A-Z0-9_]{1,79}$/),
    name: z.string().min(1),
    symbol: z.string().min(1),
    decimals: z.number().int().min(0),
    standard: z.enum(["internal", "iso4217", "erc20", "spl"]),
    chain: z.string().optional(),
    peg: z.object({ vs: z.string(), source: z.string() }).strict().optional(),
    ruleSet,
    partitions: z.array(partitionSpec).optional(),
  })
  .strict()

const assetEntry = z.union([z.object({ ref: assetRef }).strict(), assetDeclaration])

const scheduleCron = z
  .object({
    kind: z.literal("cron"),
    cron: z.string().min(9).max(100),
    timezone: z.string().optional(),
    jitter_seconds: z.number().int().min(0).max(3600).optional(),
    catchup: z.enum(["skip", "one", "all"]).optional(),
  })
  .strict()
const scheduleCalendar = z
  .object({ kind: z.literal("calendar"), rrule: z.string().min(1), timezone: z.string().optional() })
  .strict()
const scheduleEvent = z
  .object({ kind: z.literal("event"), on: z.string().min(1), filter: z.record(z.string(), z.any()).optional() })
  .strict()
const scheduleManual = z.object({ kind: z.literal("manual") }).strict()

const conversion = z
  .object({
    id,
    from: assetRef,
    to: assetRef,
    rate: z
      .union([
        z.object({ kind: z.literal("fixed"), ratio: z.number().gt(0) }).strict(),
        z.object({ kind: z.literal("oracle"), source: z.string().min(1) }).strict(),
      ])
      .optional(),
    rail: railId.optional(),
    mint: z.object({ partition: partitionId, expires: expiry.optional() }).strict(),
    bonus: z
      .object({
        strategy: z.literal("tiered-lots/v1"),
        partition: partitionId,
        tiers: z.array(z.tuple([z.number().int().min(0), z.number().min(0).max(100)])).min(1),
      })
      .strict()
      .optional(),
    capMinor: z.object({ amount: z.number().int().min(0), windowSec: z.number().int().min(1) }).strict().optional(),
    enabled: z.boolean().optional(),
  })
  .strict()
  .superRefine((c, ctx) => {
    // if `from` is fiat: rail required, rate forbidden. Else: rate required, rail and bonus forbidden.
    if (fiatRef.test(c.from)) {
      if (c.rail === undefined) ctx.addIssue({ code: "custom", path: ["rail"], message: "a fiat conversion needs a rail" })
      if (c.rate !== undefined) ctx.addIssue({ code: "custom", path: ["rate"], message: "the rate of a fiat entry is computed from anchor and fx (rule 26)" })
    } else {
      if (c.rate === undefined) ctx.addIssue({ code: "custom", path: ["rate"], message: "a non-fiat conversion needs a rate" })
      if (c.rail !== undefined) ctx.addIssue({ code: "custom", path: ["rail"], message: "rail only on a fiat entry" })
      if (c.bonus !== undefined) ctx.addIssue({ code: "custom", path: ["bonus"], message: "bonus only on a fiat entry (rule 21)" })
    }
  })

const include = z.union([
  z.object({ feature: featureId }).strict(),
  z
    .object({
      feature: featureId,
      amountMinor: z.number().int().min(0),
      partition: partitionId,
      rollover: z.enum(["none", "unbounded"]).optional(),
    })
    .strict(),
])

const price = z.union([
  z.object({ model: z.enum(["one-time", "prepaid-pool"]), amountMinor: z.number().int().min(1), currency }).strict(),
  z
    .object({
      model: z.literal("prepaid-pool"),
      amountMinor: z.literal("buyer"),
      minMinor: z.number().int().min(1).optional(),
      maxMinor: z.number().int().min(1).optional(),
      currency,
    })
    .strict(),
  z
    .object({
      model: z.literal("subscription"),
      amountMinor: z.number().int().min(1),
      currency,
      interval: z.enum(["week", "month", "year"]),
      intervalCount: z.number().int().min(1).optional(),
    })
    .strict(),
  z.looseObject({ model: vendorStrategy }),
])

const offer = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9_-]*$/),
    price,
    convert: id.optional(),
    includes: z.array(include).optional(),
    subscription: z
      .object({ anchor: z.enum(["payment", "calendar"]), grace: duration.optional(), onUpgrade: z.enum(["none", "prorate"]) })
      .strict()
      .optional(),
    rail: z
      .record(railId, z.object({ lookupKey: z.string().min(1) }).strict())
      .refine(r => Object.keys(r).length >= 1, "at least one rail")
      .optional(),
  })
  .strict()
  .superRefine((o, ctx) => {
    const model = o.price.model
    if (model === "prepaid-pool") {
      if (o.convert === undefined) ctx.addIssue({ code: "custom", path: ["convert"], message: "a prepaid-pool offer needs convert" })
      if (o.includes !== undefined) ctx.addIssue({ code: "custom", path: ["includes"], message: "includes on a prepaid-pool offer (rule 21)" })
    } else if (o.convert !== undefined) {
      ctx.addIssue({ code: "custom", path: ["convert"], message: "convert outside prepaid-pool (rule 21)" })
    }
    if (model === "subscription") {
      if (o.subscription === undefined) ctx.addIssue({ code: "custom", path: ["subscription"], message: "a subscription offer needs a subscription block" })
      if (o.includes === undefined) ctx.addIssue({ code: "custom", path: ["includes"], message: "a subscription offer needs includes" })
    } else if (o.subscription !== undefined) {
      ctx.addIssue({ code: "custom", path: ["subscription"], message: "subscription block outside the subscription model (rule 21)" })
    }
  })

const grant = z
  .object({
    id,
    trigger: z.union([scheduleCron, scheduleCalendar, scheduleEvent, scheduleManual]),
    eligible: z.object({ plans: z.array(z.string().min(1)).min(1).optional() }).strict().optional(),
    amount: z.union([
      z.object({ fixedMinor: z.number().int().min(1) }).strict(),
      z.object({ fromContext: z.literal(true) }).strict(),
      z.object({ strategy: vendorStrategy }).strict(),
    ]),
    partition: partitionId,
    mode: z.enum(["add", "top-up"]).optional(),
    expires: expiry.optional(),
    key: z.string().regex(/\{account\}/),
  })
  .strict()

const usageCategory = z
  .object({
    id,
    match: z
      .object({ kind: z.string().min(1), model: z.string().min(1), channel: z.string().min(1), op: z.string().min(1) })
      .partial()
      .strict()
      .optional(),
    cost: z.discriminatedUnion("source", [
      z.object({ source: z.literal("measured") }).strict(),
      z.object({ source: z.literal("catalog") }).strict(),
      z.object({ source: z.literal("fixed"), amount: z.number().min(0), currency }).strict(),
    ]),
    margin: z.union([z.number().gt(0), z.literal("at-cost")]).optional(),
    marginFloor: z.number().gt(0).optional(),
    floorMinor: z.number().int().min(0).optional(),
    mode: z.enum(["hold", "direct", "shadow"]).optional(),
  })
  .strict()

const usage = z
  .object({
    defaults: z
      .object({ margin: z.number().gt(0), floorMinor: z.number().int().min(0), mode: z.enum(["hold", "direct", "shadow"]) })
      .partial()
      .strict()
      .optional(),
    categories: z.array(usageCategory).min(1),
  })
  .strict()

export const billingFrontmatterSchema = z
  .object({
    schema: z.literal("billing/v1"),
    name: id,
    title: z.string().min(1),
    version: z.string().regex(/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/),
    assets: z.array(assetEntry).min(1),
    primaryAsset: assetRef,
    anchor: z.object({ currency, creditsPerUnit: z.number().gt(0) }).strict(),
    fx: z.record(currency, z.number().gt(0)).optional(),
    spendOrder: z.array(partitionId).optional(),
    usage: usage.optional(),
    taxBasis: z.enum(["net", "gross"]).optional(),
    features: z.array(z.object({ id: featureId, type: z.enum(["boolean", "credits"]) }).strict()).optional(),
    accounts: z
      .object({
        kinds: z.array(id).min(1),
        hierarchy: z
          .object({
            maxDepth: z.number().int().min(0).max(3),
            funding: z.array(z.enum(["pool", "allocated_budget"])),
          })
          .strict(),
      })
      .strict(),
    payer: z
      .object({
        strategy: z.union([z.enum(["self", "hierarchy/v1"]), vendorStrategy]),
        owner: z.array(z.string().min(1)).min(1),
        affordability: z.enum(["balance", "spendable"]).optional(),
      })
      .strict(),
    transfers: z
      .object({
        allow: z.array(z.enum(["allocate", "reclaim"])).min(1),
        from: z.array(partitionId).optional(),
        expiry: z.literal("inherit").optional(),
      })
      .strict()
      .optional(),
    conversions: z.array(conversion).optional(),
    offers: z.array(offer).optional(),
    grants: z.array(grant).optional(),
    rails: z.array(
      z
        .object({
          id: railId,
          provider: railId.optional(),
          productTag: z.string().min(1).optional(),
          env: z.object({ secretKey: envName.optional(), webhookSecret: envName.optional(), mode: envName.optional() }).strict().optional(),
        })
        .strict(),
    ),
    metadata: z.record(z.string(), z.any()).optional(),
  })
  .strict()

export type BillingFrontmatter = z.infer<typeof billingFrontmatterSchema>
