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

/**
 * Canonical provider → api-key ENVIRONMENT VARIABLE name — the single source
 * of truth for "which env var carries this provider's LLM billing key". Lives
 * here, next to {@link CatalogProviderSchema}, because provider identity and
 * its key env are the same fact (adding a provider to the enum forces adding
 * its key env, or this `Record<CatalogProvider, string>` fails to type-check —
 * the compile-time equivalent of catalog-sync keeping it current).
 *
 * `@agentproto/runtime`'s `providers-store` DERIVES `PROVIDER_ENV_VARS` from
 * this map (re-exporting it plus a few non-catalog gateway keys like `groq` /
 * `vercel-ai-gateway`), and the billing-auth resolver calls
 * `providerEnvVar(provider)` rather than ever re-listing these names per
 * adapter manifest. Names follow each SDK's own convention (matching the
 * adapter manifests' `models.env` maps). This is the api-key axis ONLY — the
 * `subscription` (Anthropic OAuth) env var is consumer-specific and declared
 * per Claude adapter, not here.
 */
export const PROVIDER_KEY_ENV: Record<CatalogProvider, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  assemblyai: "ASSEMBLYAI_API_KEY",
  deepgram: "DEEPGRAM_API_KEY",
  elevenlabs: "ELEVENLABS_API_KEY",
  "gemini-live": "GOOGLE_GENERATIVE_AI_API_KEY",
  google: "GOOGLE_GENERATIVE_AI_API_KEY",
  minimax: "MINIMAX_API_KEY",
  mistral: "MISTRAL_API_KEY",
  moonshot: "MOONSHOT_API_KEY",
  openai: "OPENAI_API_KEY",
  "openai-realtime": "OPENAI_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  replicate: "REPLICATE_API_TOKEN",
}

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
