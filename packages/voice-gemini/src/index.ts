import { defineVoiceProvider, type VoiceProvider } from "@agentproto/voice"
import { makeGeminiLive, type GeminiLiveConfig } from "./live.js"

export { makeGeminiLive, resolveGeminiKey, type GeminiLiveConfig } from "./live.js"
export { nodeSocketFactory, BIDI_PATH, DEFAULT_WS_BASE_URL } from "./transport.js"

export interface GeminiProviderConfig extends GeminiLiveConfig {}

/**
 * Build the provider: Live (speech-to-speech) only. Streaming and file STT,
 * and TTS, stay with the other providers of the kit; the key is read lazily,
 * at each call, from `GEMINI_API_KEY` (else `GOOGLE_API_KEY`) unless given.
 */
export function createGeminiProvider(cfg: GeminiProviderConfig = {}): VoiceProvider {
  return defineVoiceProvider({
    slug: "gemini",
    name: "Gemini",
    env: { apiKey: "GEMINI_API_KEY" },
    realtime: makeGeminiLive(cfg),
  })
}

/** The default provider instance: key from the environment. */
export const gemini: VoiceProvider = createGeminiProvider()
export default gemini
