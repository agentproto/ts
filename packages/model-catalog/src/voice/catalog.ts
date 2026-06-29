/**
 * Unified voice catalog — the single source of truth for every curated
 * TTS / realtime voice across providers. Per-provider sources under
 * `providers/` are concatenated here; the registry exposes them as
 * `kind: "voice"`, and the runtime merge layer (agent-framework) appends
 * live ElevenLabs voices on top.
 *
 * Users pick voices by natural label ("Victoire", "Camille", "Pierre"…);
 * provider details are internal — resolved by `resolveVoice()`.
 */

import type { CatalogVoice, CatalogVoiceProvider } from "../schema/voice.js"
import { MINIMAX_VOICES } from "./providers/minimax.js"
import { ELEVENLABS_VOICES } from "./providers/elevenlabs.js"
import { OPENAI_REALTIME_VOICES } from "./providers/openai-realtime.js"
import { GEMINI_LIVE_VOICES } from "./providers/gemini-live.js"

/**
 * Every curated voice, ordered featured-FR first then by provider. Saved
 * `operator.voiceId` rows reference `catalogId`, so ordering is pure UX.
 *
 * Intentionally NOT annotated `: CatalogVoice[]` — the per-provider arrays
 * are `as const satisfies`, so leaving inference intact preserves the
 * literal `catalogId`s that `CatalogVoiceId` is derived from.
 */
export const VOICE_CATALOG = [
  ...ELEVENLABS_VOICES,
  ...MINIMAX_VOICES,
  ...OPENAI_REALTIME_VOICES,
  ...GEMINI_LIVE_VOICES,
]

/**
 * The union of every curated voice's `catalogId` — autocompleted +
 * typo-checked at every call site that names a voice. Auto-derived from
 * the catalog data; never hand-maintained. Aliases (app-side legacy slugs)
 * are NOT in the union — they resolve at runtime but aren't canonical.
 */
export type CatalogVoiceId = (typeof VOICE_CATALOG)[number]["catalogId"]

/**
 * Any string that resolves to a voice — a canonical `CatalogVoiceId`
 * (autocompleted), or a `providerVoiceId` / legacy alias (free-form).
 * The `string & {}` keeps the literal-union autocomplete while still
 * accepting arbitrary ids.
 */
export type VoiceRef = CatalogVoiceId | (string & {})

// Triple-index for O(1) lookups: canonical id, native provider id, alias.
const VOICE_BY_CATALOG_ID = new Map<string, CatalogVoice>(
  VOICE_CATALOG.map(v => [v.catalogId, v])
)
const VOICE_BY_PROVIDER_ID = new Map<string, CatalogVoice>(
  VOICE_CATALOG.map(v => [v.providerVoiceId, v])
)
const VOICE_BY_ALIAS = new Map<string, CatalogVoice>(
  VOICE_CATALOG.flatMap((v: CatalogVoice) =>
    (v.aliases ?? []).map(a => [a, v] as const)
  )
)

/** Get all voices, optionally filtered by primary language. */
export function getVoiceCatalog(language?: string): readonly CatalogVoice[] {
  if (language) {
    return VOICE_CATALOG.filter(v => v.primaryLanguage === language)
  }
  return VOICE_CATALOG
}

/** Look up a voice by its canonical catalogId ("elevenlabs-victoire"). */
export function getVoiceByCatalogId(
  catalogId: VoiceRef
): CatalogVoice | undefined {
  return VOICE_BY_CATALOG_ID.get(catalogId)
}

/** Look up a voice by its native provider id ("French_FemaleAnchor"). */
export function getVoiceByProviderVoiceId(
  providerVoiceId: string
): CatalogVoice | undefined {
  return VOICE_BY_PROVIDER_ID.get(providerVoiceId)
}

/**
 * Resolve a voice by canonical catalogId, then native providerVoiceId,
 * then legacy alias — works with new slugs, native ids, and the old
 * app-specific alias slugs (e.g. a consumer overlay).
 */
export function resolveVoice(ref: VoiceRef): CatalogVoice | undefined {
  return (
    VOICE_BY_CATALOG_ID.get(ref) ??
    VOICE_BY_PROVIDER_ID.get(ref) ??
    VOICE_BY_ALIAS.get(ref)
  )
}

/** @deprecated Use `resolveVoice()`. Kept for backward compat. */
export function getVoiceById(id: VoiceRef): CatalogVoice | undefined {
  return resolveVoice(id)
}

/** Featured voices (shown in the picker), optionally filtered by language. */
export function getFeaturedVoices(language?: string): readonly CatalogVoice[] {
  return VOICE_CATALOG.filter(
    (v: CatalogVoice) =>
      v.featured && (!language || v.primaryLanguage === language)
  )
}

/**
 * Resolve which provider owns a voice and the native provider voice id.
 * Accepts a canonical id, native id, or alias.
 */
export function getProviderForVoice(
  ref: VoiceRef
): { provider: CatalogVoiceProvider; providerVoiceId: string } | undefined {
  const voice = resolveVoice(ref)
  if (!voice) return undefined
  return { provider: voice.provider, providerVoiceId: voice.providerVoiceId }
}
