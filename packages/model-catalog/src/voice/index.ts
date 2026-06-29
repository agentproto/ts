/**
 * Voice subpath — the unified, provider-neutral voice catalog.
 *
 * Voices are a first-class catalog kind: authored per-provider under
 * `providers/`, concatenated into `VOICE_CATALOG`, and queryable through
 * the registry (`listModels({ kind: "voice", providers: [...] })`).
 * Execution (the speech adapters) and the runtime ElevenLabs-live merge
 * (agent-framework) read from here.
 */

export type { CatalogVoice, CatalogVoiceProvider } from "../schema/voice.js"
export {
  CatalogVoiceSchema,
  CatalogVoiceProviderSchema,
} from "../schema/voice.js"

export {
  VOICE_CATALOG,
  getVoiceCatalog,
  getVoiceByCatalogId,
  getVoiceByProviderVoiceId,
  resolveVoice,
  getVoiceById,
  getFeaturedVoices,
  getProviderForVoice,
} from "./catalog.js"
export type { CatalogVoiceId, VoiceRef } from "./catalog.js"

export { curateVoice, slugifyVoiceId } from "./curate.js"
export type { NativeVoice, VoiceCurationOverrides } from "./curate.js"

export {
  VOICE_PREVIEW_BASE,
  VOICE_PREVIEW_LOCALES,
  BAKED_VOICE_PREVIEWS,
  voicePreviewUrl,
} from "./preview-manifest.generated.js"

export { MINIMAX_VOICES } from "./providers/minimax.js"
export { ELEVENLABS_VOICES } from "./providers/elevenlabs.js"
export { OPENAI_REALTIME_VOICES } from "./providers/openai-realtime.js"
export { GEMINI_LIVE_VOICES } from "./providers/gemini-live.js"
