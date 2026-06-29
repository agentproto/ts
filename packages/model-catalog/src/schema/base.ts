import { z } from "zod"

/**
 * Shared schema fragments for every model catalog entry.
 *
 * `baseEntryShape` is spread into per-kind schemas so each kind stays a
 * plain `z.object` — required by `z.discriminatedUnion`.
 *
 * Mirrors the pattern in
 * `packages/agencies/registry-client/src/types.ts` (`basePayloadShape`).
 */

export const ModelKindSchema = z.enum(["llm", "image", "video", "audio"])
export type ModelKind = z.infer<typeof ModelKindSchema>

export const LifecycleSchema = z.enum(["stable", "preview", "deprecated"])
export type Lifecycle = z.infer<typeof LifecycleSchema>

/**
 * `catalogPriceTier` — the model's intrinsic cost bucket. Distinct from
 * `subscriptionPlanTier` (the user's billing level) and `modelPreset`
 * (an app's per-conversation UX picker). Always qualify when discussing
 * tiers — bare `priceTier` / `tier` is ambiguous in this codebase.
 */
export const CatalogPriceTierSchema = z.enum(["low", "mid", "high", "premium"])
export type CatalogPriceTier = z.infer<typeof CatalogPriceTierSchema>

export const NsfwPolicySchema = z.enum(["filtered", "permissive", "strict"])
export type NsfwPolicy = z.infer<typeof NsfwPolicySchema>

/**
 * Canonical model-provider registry — the single source of truth for the
 * `provider` field on every catalog entry. Adding a model on a new
 * provider means adding it here first, so a typo or an un-onboarded
 * provider is a validation/build error rather than a silently-broken
 * entry. `CatalogVoiceProviderSchema` is the voice-callable subset.
 */
export const CatalogProviderSchema = z.enum([
  "anthropic",
  "assemblyai",
  "deepgram",
  "elevenlabs",
  "gemini-live",
  "google",
  "minimax",
  "mistral",
  "moonshot",
  "openai",
  "openai-realtime",
  "openrouter",
  "replicate",
])
export type CatalogProvider = z.infer<typeof CatalogProviderSchema>

export const baseEntryShape = {
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().default(""),
  provider: CatalogProviderSchema,
  providerId: z.string().min(1),
  agentVisible: z.boolean().default(false),
  lifecycle: LifecycleSchema.default("stable"),
  tags: z.array(z.string()).default([]),
  catalogPriceTier: CatalogPriceTierSchema.default("mid"),
  nsfwPolicy: NsfwPolicySchema.default("filtered"),
  regions: z.array(z.string()).optional(),
  aliases: z.array(z.string()).optional(),
} as const
