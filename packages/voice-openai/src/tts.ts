/**
 * OpenAI text-to-speech: `POST https://api.openai.com/v1/audio/speech`.
 * With `response_format: "pcm"` the body is raw PCM16 mono at 24 kHz, which
 * is what the voice kit speaks. The studio runs the same route for previews
 * (`af/voice/preview.ts`, with `wav`); this package asks for `pcm`.
 * There is no separate OpenAI TTS WebSocket; spoken output of a realtime
 * session comes from realtime.ts.
 */
import { VOICE_DEFAULTS, type TtsProvider } from "@agentproto/voice"
import { DEFAULT_BASE_URL, type OpenAITransport } from "./transport.js"
import { resolveApiKey } from "./stt.js"

const D = VOICE_DEFAULTS.providers.openai

export interface OpenAITtsConfig extends OpenAITransport {
  apiKey?: string | (() => string | undefined)
  modelId?: string
  voiceId?: string
}

export function makeOpenAITts(cfg: OpenAITtsConfig = {}): TtsProvider {
  const model = () => cfg.modelId ?? D.ttsModel.value
  const voice = (v?: string) => v ?? cfg.voiceId ?? D.ttsVoice.value
  const rate = D.ttsSampleRate.value

  return {
    slug: "openai",
    get model() {
      return model()
    },
    capabilities: {
      streaming: false,
      file: true,
      chunkedInput: false,
      cancel: false,
      languages: [],
      outputSampleRates: [rate],
    },

    async openStream(): Promise<never> {
      throw new Error("openai tts: no streaming endpoint; use synthesize() or the realtime session")
    },

    async synthesize(input: { text: string; voiceId?: string; language?: string; signal?: AbortSignal }) {
      const apiKey = resolveApiKey(cfg)
      const f = cfg.fetch ?? fetch
      const res = await f(`${cfg.baseUrl ?? DEFAULT_BASE_URL}/v1/audio/speech`, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({
          model: model(),
          voice: voice(input.voiceId),
          input: input.text,
          response_format: "pcm",
        }),
        ...(input.signal ? { signal: input.signal } : {}),
      } as RequestInit)
      if (!res.ok) throw new Error(`openai tts: HTTP ${res.status} ${(await res.text().catch(() => "")).slice(0, 160)}`)
      const bytes = new Uint8Array(await res.arrayBuffer())
      return { bytes, mimeType: "audio/pcm", durationSeconds: bytes.byteLength / 2 / rate }
    },
  }
}
