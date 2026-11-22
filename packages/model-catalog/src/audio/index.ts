/**
 * Audio catalog subpath — provider × model pricing for TTS and STT
 * (ElevenLabs Multilingual/Turbo/Flash, OpenAI TTS-1/HD, Whisper,
 * Deepgram Nova, AssemblyAI Universal, etc.). Drives
 * `calculateCost(modelId, { kind: "audio", … })`.
 *
 * Voices are NOT here — they're a first-class catalog kind under
 * `@agentproto/model-catalog/voice` (`VOICE_CATALOG`), provider-neutral and
 * queryable via the registry (`listModels({ kind: "voice" })`).
 */
export {
  AUDIO_MODEL_CATALOG,
  AUDIO_MODEL_IDS,
  AGENT_AUDIO_MODEL_IDS,
  AGENT_TTS_MODEL_IDS,
  AGENT_STT_MODEL_IDS,
  S2S_MODEL_IDS,
  GEMINI_LIVE_MODEL_IDS,
  DEFAULT_GEMINI_LIVE_MODEL,
  isAcceptedGeminiLiveModel,
  generateAudioModelTable,
} from "./catalog.js"
// `AudioCapabilities` and `AudioPricing` collide with the zod-derived
// types in `../schema/audio.ts` re-exported from the package root, so
// they stay private to the catalog file. Consumers reach them via
// `AudioModelDefinition` properties.
export type {
  AudioModelDefinition,
  AudioModality,
  AudioBillingUnit,
  AudioProvider,
} from "./catalog.js"
// Live/realtime auto-synced roster (audio:openai-live generator) + the
// curation bridge between it and the curated catalog above.
export {
  OPENAI_LIVE_MODELS,
  OPENAI_LIVE_MODEL_IDS,
  CURATED_OPENAI_AUDIO_PROVIDER_IDS,
  isCuratedOpenAIAudioModel,
  openaiLiveIdsNeedingCuration,
} from "./live.js"
export type { AudioLiveModelEntry } from "./live.js"
