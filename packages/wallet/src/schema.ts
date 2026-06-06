/**
 * Zod schema for the ERC-20-style asset declaration (AIP-49). Used by
 * `defineAsset` for field-level validation and as the source of the JSON Schema
 * shipped under `resources/aip-49/draft/`.
 */

import { z } from "zod"

const restrictionSchema = z.array(z.string().min(1))

const convertEdgeSchema = z
  .object({
    to: z.string().min(1),
    rate: z.union([
      z.object({ kind: z.literal("fixed"), ratio: z.number().positive() }),
      z.object({ kind: z.literal("oracle"), source: z.string().min(1) }),
    ]),
    addsRestriction: restrictionSchema.optional(),
    cap: z
      .object({
        amount: z.number().nonnegative(),
        windowSec: z.number().positive(),
      })
      .optional(),
  })
  .strict()

const timeSpecSchema = z.union([
  z.object({ kind: z.literal("afterGrant"), ms: z.number().nonnegative() }).strict(),
  z.object({ kind: z.literal("absolute"), at: z.number().nonnegative() }).strict(),
])

const partitionRuleSchema = z.union([
  z
    .object({ kind: z.literal("spendOn"), categories: z.array(z.string().min(1)) })
    .strict(),
  z.object({ kind: z.literal("restrict"), tags: restrictionSchema }).strict(),
  z.object({ kind: z.literal("expire"), at: timeSpecSchema }).strict(),
  z
    .object({
      kind: z.literal("decay"),
      curve: z.enum(["linear", "exponential"]),
      ratePerDay: z.number().min(0).max(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal("vest"),
      cliff: timeSpecSchema.optional(),
      durationMs: z.number().positive(),
    })
    .strict(),
  z
    .object({ kind: z.literal("transfer"), scope: z.enum(["soulbound", "account", "open"]) })
    .strict(),
])

const partitionSpecSchema = z
  .object({
    id: z.string().min(1),
    asset: z.string().min(1),
    restriction: restrictionSchema,
    spendableOn: z.array(z.string()).optional(),
    defaultTtlMs: z.number().positive().optional(),
    policy: z.array(partitionRuleSchema).optional(),
  })
  .strict()

const ruleSetSchema = z
  .object({
    settleOut: z.union([
      z.literal(false),
      z.enum(["internal-ledger", "stripe", "pawapay", "x402", "solana"]),
    ]),
    spendableOn: z.array(z.string()),
    convertEdges: z.array(convertEdgeSchema),
    transfer: z.enum(["none", "internal", "external"]),
    custody: z.enum(["custodial-mirror", "on-chain-authority"]).optional(),
  })
  .strict()

export const assetDeclarationSchema = z
  .object({
    ref: z.string().regex(/^[A-Z0-9][A-Z0-9_]{1,79}$/),
    name: z.string().min(1),
    symbol: z.string().min(1),
    decimals: z.number().int().min(0).max(18),
    standard: z.enum(["internal", "iso4217", "erc20", "spl"]),
    chain: z.string().min(1).optional(),
    peg: z
      .object({ vs: z.string().min(1), source: z.string().min(1) })
      .strict()
      .optional(),
    ruleSet: ruleSetSchema,
    partitions: z.array(partitionSpecSchema).optional(),
  })
  .strict()

export type AssetDeclarationInput = z.infer<typeof assetDeclarationSchema>
