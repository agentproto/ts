import { defineVoiceProvider, type VoiceProvider } from "@agentproto/voice"
import { makeOpenAIRealtime, type OpenAIRealtimeConfig } from "./realtime.js"
import { makeOpenAIStt, type OpenAISttConfig } from "./stt.js"
import { makeOpenAITts, type OpenAITtsConfig } from "./tts.js"
import type { OpenAITransport } from "./transport.js"

export { makeOpenAIStt, wavFromPcm16, type OpenAISttConfig } from "./stt.js"
export { makeOpenAITts, type OpenAITtsConfig } from "./tts.js"
export { makeOpenAIRealtime, type OpenAIRealtimeConfig } from "./realtime.js"
export { nodeSocketFactory, type OpenAITransport } from "./transport.js"

export interface OpenAIProviderConfig extends OpenAITransport {
  apiKey?: string | (() => string | undefined)
  stt?: Omit<OpenAISttConfig, keyof OpenAITransport | "apiKey">
  tts?: Omit<OpenAITtsConfig, keyof OpenAITransport | "apiKey">
  realtime?: Omit<OpenAIRealtimeConfig, keyof OpenAITransport | "apiKey">
}

/** Build the provider; the key is read lazily, at each call, from `OPENAI_API_KEY` unless given. */
export function createOpenAIProvider(cfg: OpenAIProviderConfig = {}): VoiceProvider {
  const t: OpenAITransport = {
    ...(cfg.socket ? { socket: cfg.socket } : {}),
    ...(cfg.fetch ? { fetch: cfg.fetch } : {}),
    ...(cfg.baseUrl ? { baseUrl: cfg.baseUrl } : {}),
    ...(cfg.wsBaseUrl ? { wsBaseUrl: cfg.wsBaseUrl } : {}),
  }
  const apiKey = cfg.apiKey
  return defineVoiceProvider({
    slug: "openai",
    name: "OpenAI",
    env: { apiKey: "OPENAI_API_KEY" },
    // `whisper` is the historical value of VOICE_STT_PROVIDER (Simone prod, compose.yaml:89).
    valueAliases: { stt: ["whisper"] },
    stt: makeOpenAIStt({ ...t, ...(apiKey !== undefined ? { apiKey } : {}), ...cfg.stt }),
    tts: makeOpenAITts({ ...t, ...(apiKey !== undefined ? { apiKey } : {}), ...cfg.tts }),
    realtime: makeOpenAIRealtime({ ...t, ...(apiKey !== undefined ? { apiKey } : {}), ...cfg.realtime }),
  })
}

/** The default provider instance: key from the environment. */
export const openai: VoiceProvider = createOpenAIProvider()
export default openai
