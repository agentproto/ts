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
  "requesty",
  "xai",
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
  requesty: "REQUESTY_API_KEY",
  xai: "XAI_API_KEY",
}

/**
 * ADDITIONAL env-var names that carry the *same* provider key, beyond the one
 * canonical name in {@link PROVIDER_KEY_ENV}. Some consumers read a different
 * alias for a provider than the name we canonically inject, so a key set once
 * (`agentproto auth provider set <provider> <key>`) must be able to satisfy
 * every alias, not just the canonical name. `providers-store` derives its
 * `PROVIDER_ENV_ALIASES` from this and injects the canonical name PLUS every
 * alias at `serve` boot (explicit env still wins, per env name).
 *
 * Aliases are VERIFIED against a real consumer, never guessed — an alias we
 * cannot prove a consumer reads does not belong here:
 *
 * - `google: ["GOOGLE_API_KEY"]` — mastracode / `@mastra/core`. Its
 *   `PROVIDER_REGISTRY.google.apiKeyEnvVar` is the alias array
 *   `["GOOGLE_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY"]`, but
 *   `@mastra/code-sdk`'s `getApiKeyEnvVar()` collapses it to `envVars[0]`
 *   (`GOOGLE_API_KEY`) before testing `Boolean(process.env[…])`. So mastracode
 *   consults ONLY `GOOGLE_API_KEY`; our canonical `GOOGLE_GENERATIVE_AI_API_KEY`
 *   is invisible to it. (Confirmed in the installed mastracode 0.26.x tree.)
 * - `moonshot: ["MOONSHOT_AI_API_KEY"]` — mastracode again, but via a HARDCODED
 *   branch that bypasses the registry entirely:
 *   `@mastra/code-sdk/dist/agents/mastracode-gateway.js:331-333` does
 *   `if (args.providerId === "moonshotai") { if (!process.env.MOONSHOT_AI_API_KEY) throw … }`.
 *   It reads `MOONSHOT_AI_API_KEY` (note the `_AI_`); we inject `MOONSHOT_API_KEY`
 *   via {@link PROVIDER_KEY_ENV}. Because the name is hardcoded, not
 *   registry-declared, the next reader cannot discover it from the registry —
 *   hence this comment. (The provider slug drifts too: `moonshotai` upstream vs
 *   our `moonshot`; the alias handles the env NAME, which is what matters here.)
 *
 * `gemini-live` is deliberately absent: no consumer of that provider is known
 * to read `GOOGLE_API_KEY`, so per the verify-not-guess rule it stays out. The
 * drift set is capped: across the providers we share with mastracode, only
 * `google` and `moonshot` diverge — anthropic / openai / openrouter / xai /
 * mistral / minimax (and the non-catalog groq) all match, so none are added.
 *
 * `Partial` because most providers have no known alias — a provider absent
 * here just gets its single canonical name injected.
 */
export const PROVIDER_KEY_ENV_ALIASES = {
  google: ["GOOGLE_API_KEY"],
  moonshot: ["MOONSHOT_AI_API_KEY"],
} satisfies Partial<Record<CatalogProvider, readonly string[]>>

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
