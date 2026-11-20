import { defineVoiceProvider, type VoiceProvider } from "@agentproto/voice"
import { makeElevenLabsRealtime, type ElevenLabsRealtimeConfig } from "./realtime.js"
import { makeElevenLabsStt, type ElevenLabsSttConfig } from "./stt.js"
import { makeElevenLabsTts, type ElevenLabsTtsConfig } from "./tts.js"
import type { ElevenLabsTransport } from "./transport.js"

export { makeElevenLabsTts, pcmRateOf, type ElevenLabsTtsConfig } from "./tts.js"
export { makeElevenLabsStt, wavFromPcm16, type ElevenLabsSttConfig } from "./stt.js"
export { makeElevenLabsRealtime, type ElevenLabsRealtimeConfig, type ElevenLabsAgentOptions } from "./realtime.js"
export { SCRIBE_HALLUCINATION_PATTERNS, isScribeHallucination } from "./hallucination.js"
export { nodeSocketFactory, type ElevenLabsTransport } from "./transport.js"

export interface ElevenLabsProviderConfig extends ElevenLabsTransport {
  apiKey?: string | (() => string | undefined)
  tts?: Omit<ElevenLabsTtsConfig, keyof ElevenLabsTransport | "apiKey">
  stt?: Omit<ElevenLabsSttConfig, keyof ElevenLabsTransport | "apiKey">
  realtime?: Omit<ElevenLabsRealtimeConfig, keyof ElevenLabsTransport | "apiKey">
}

/** Build the provider; the key is read lazily, at each call, from `ELEVENLABS_API_KEY` unless given. */
export function createElevenLabsProvider(cfg: ElevenLabsProviderConfig = {}): VoiceProvider {
  const t: ElevenLabsTransport = {
    ...(cfg.socket ? { socket: cfg.socket } : {}),
    ...(cfg.fetch ? { fetch: cfg.fetch } : {}),
    ...(cfg.baseUrl ? { baseUrl: cfg.baseUrl } : {}),
    ...(cfg.wsBaseUrl ? { wsBaseUrl: cfg.wsBaseUrl } : {}),
    ...(cfg.apiKey !== undefined ? { apiKey: cfg.apiKey } : {}),
  } as ElevenLabsTransport & { apiKey?: string | (() => string | undefined) }
  return defineVoiceProvider({
    slug: "elevenlabs",
    name: "ElevenLabs",
    env: { apiKey: "ELEVENLABS_API_KEY" },
    // `scribe` is the historical value of VOICE_STT_PROVIDER (streaming recognition).
    valueAliases: { stt: ["scribe"] },
    tts: makeElevenLabsTts({ ...t, ...cfg.tts }),
    stt: makeElevenLabsStt({ ...t, ...cfg.stt }),
    realtime: makeElevenLabsRealtime({ ...t, ...cfg.realtime }),
  })
}

/** The default provider instance: key from the environment. */
export const elevenlabs: VoiceProvider = createElevenLabsProvider()
export default elevenlabs
