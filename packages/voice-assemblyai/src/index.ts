import { defineVoiceProvider, type VoiceProvider } from "@agentproto/voice"
import { makeAssemblyAIStt, type AssemblyAISttConfig } from "./stt.js"
import { makeAssemblyAITts, type AssemblyAITtsConfig } from "./tts.js"
import type { AssemblyAITransport } from "./transport.js"

export { makeAssemblyAIStt, wavFromPcm16, type AssemblyAISttConfig } from "./stt.js"
export { makeAssemblyAITts, TTS_LANGUAGES, TTS_SAMPLE_RATES, languageName, type AssemblyAITtsConfig } from "./tts.js"
export { nodeSocketFactory, type AssemblyAITransport } from "./transport.js"

export interface AssemblyAIProviderConfig extends AssemblyAITransport {
  apiKey?: string | (() => string | undefined)
  stt?: Omit<AssemblyAISttConfig, keyof AssemblyAITransport | "apiKey">
  tts?: Omit<AssemblyAITtsConfig, keyof AssemblyAITransport | "apiKey">
}

/** Build the provider; the key is read lazily, at each call, from `ASSEMBLYAI_API_KEY` unless given. */
export function createAssemblyAIProvider(cfg: AssemblyAIProviderConfig = {}): VoiceProvider {
  const t: AssemblyAITransport = {
    ...(cfg.socket ? { socket: cfg.socket } : {}),
    ...(cfg.fetch ? { fetch: cfg.fetch } : {}),
    ...(cfg.baseUrl ? { baseUrl: cfg.baseUrl } : {}),
    ...(cfg.wsBaseUrl ? { wsBaseUrl: cfg.wsBaseUrl } : {}),
    ...(cfg.ttsBaseUrl ? { ttsBaseUrl: cfg.ttsBaseUrl } : {}),
    ...(cfg.ttsWsBaseUrl ? { ttsWsBaseUrl: cfg.ttsWsBaseUrl } : {}),
  }
  const apiKey = cfg.apiKey
  return defineVoiceProvider({
    slug: "assemblyai",
    name: "AssemblyAI",
    env: { apiKey: "ASSEMBLYAI_API_KEY" },
    stt: makeAssemblyAIStt({ ...t, ...(apiKey !== undefined ? { apiKey } : {}), ...cfg.stt }),
    tts: makeAssemblyAITts({ ...t, ...(apiKey !== undefined ? { apiKey } : {}), ...cfg.tts }),
  })
}

/** The default provider instance: key from the environment. */
export const assemblyai: VoiceProvider = createAssemblyAIProvider()
export default assemblyai
