/**
 * Curate a voice FROM provider-native data — the runtime analog of the
 * codegen that authors the static per-provider files.
 *
 * The point: a curated entry is DERIVED from the provider's own data, so
 * the display name defaults to the real provider name (rebrand becomes
 * opt-in, never accidental) and the `catalogId` is derived unless pinned.
 * Used by the live-voice merge (e.g. ElevenLabs `/v1/voices` rows) and
 * anywhere a provider row needs to become a `CatalogVoice`.
 *
 * Note: runtime-curated ids are `string`, not `CatalogVoiceId` — they
 * come from dynamic data and aren't part of the compile-time union. The
 * static catalog (authored as `as const`) is what powers autocomplete.
 */

import type { CatalogVoice, CatalogVoiceProvider } from "../schema/voice.js"

/** Provider-native voice data — the shape any provider source/API row reduces to. */
export interface NativeVoice {
  provider: CatalogVoiceProvider
  providerVoiceId: string
  /** The provider's own name for the voice — the default display label. */
  name: string
  gender: "female" | "male" | "neutral"
  primaryLanguage: string
  supportedLanguages: readonly string[]
  description?: string
  samplePath?: string
  age?: "child" | "young" | "adult" | "senior"
  quality?: string
}

export interface VoiceCurationOverrides {
  /** Pin the catalogId. Omit → derived `<provider>-<slug(providerVoiceId)>`. */
  catalogId?: string
  /** Override the display name. Omit → the provider's real `name` (no rebrand). */
  label?: string
  featured?: boolean
  aliases?: readonly string[]
}

/**
 * Derive a catalogId from a provider voice id: `<provider>-<slug>`, where
 * the slug splits camelCase and collapses non-alphanumerics. Same rule the
 * codegen uses to materialize the static ids — keep them in sync.
 */
export function slugifyVoiceId(
  provider: string,
  providerVoiceId: string
): string {
  const slug = providerVoiceId
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
  return `${provider}-${slug}`
}

/** Build a `CatalogVoice` from provider-native data + curation overrides. */
export function curateVoice(
  native: NativeVoice,
  overrides: VoiceCurationOverrides = {}
): CatalogVoice {
  return {
    catalogId:
      overrides.catalogId ??
      slugifyVoiceId(native.provider, native.providerVoiceId),
    providerVoiceId: native.providerVoiceId,
    provider: native.provider,
    // Default to the provider's REAL name — rebrand only when explicit.
    label: overrides.label ?? native.name,
    description: native.description ?? `${native.provider} voice`,
    gender: native.gender,
    primaryLanguage: native.primaryLanguage,
    supportedLanguages: native.supportedLanguages,
    samplePath: native.samplePath,
    aliases: overrides.aliases,
    age: native.age,
    quality: native.quality,
    featured: overrides.featured,
  }
}
