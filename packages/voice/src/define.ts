/**
 * `defineVoiceProvider` (AIP-VOICE): a provider package declares what its
 * vendor can do and which variables it reads. Nothing else about it is a
 * document.
 */
import type {
  VoiceProvider,
  VoiceProviderDefinition,
  VoiceProviderEnv,
} from "./types.js"

const SLUG_RE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/

/** `<SLUG>_API_KEY`: slug upper-cased, `-` replaced by `_`. */
export function apiKeyName(slug: string): string {
  return `${slug.toUpperCase().replace(/-/g, "_")}_API_KEY`
}

export function defineVoiceProvider(def: VoiceProviderDefinition): VoiceProvider {
  if (!SLUG_RE.test(def.slug)) {
    throw new Error(`voice provider slug "${def.slug}" is not lowercase kebab-case`)
  }
  if (!def.stt && !def.tts && !def.realtime) {
    throw new Error(`voice provider "${def.slug}" declares no stage (stt, tts or realtime)`)
  }
  const expected = apiKeyName(def.slug)
  if (def.env.apiKey !== expected) {
    throw new Error(
      `voice provider "${def.slug}": env.apiKey must be ${expected}, got ${def.env.apiKey}`,
    )
  }
  for (const stage of ["stt", "tts", "realtime"] as const) {
    const impl = def[stage]
    if (impl && impl.slug !== def.slug) {
      throw new Error(
        `voice provider "${def.slug}": its ${stage} stage reports slug "${impl.slug}"`,
      )
    }
  }
  if (def.stt && !def.stt.capabilities.streaming && !def.stt.capabilities.file) {
    throw new Error(`voice provider "${def.slug}": stt must be streaming or file`)
  }
  if (def.tts && !def.tts.capabilities.streaming && !def.tts.capabilities.file) {
    throw new Error(`voice provider "${def.slug}": tts must be streaming or file`)
  }
  const env: Required<VoiceProviderEnv> = {
    apiKey: def.env.apiKey,
    aliases: def.env.aliases ?? [],
  }
  return {
    slug: def.slug,
    name: def.name,
    env,
    valueAliases: {
      stt: def.valueAliases?.stt ?? [],
      tts: def.valueAliases?.tts ?? [],
    },
    ...(def.stt ? { stt: def.stt } : {}),
    ...(def.tts ? { tts: def.tts } : {}),
    ...(def.realtime ? { realtime: def.realtime } : {}),
    capabilities: {
      ...(def.stt ? { stt: def.stt.capabilities } : {}),
      ...(def.tts ? { tts: def.tts.capabilities } : {}),
      ...(def.realtime ? { realtime: def.realtime.capabilities } : {}),
    },
  }
}
