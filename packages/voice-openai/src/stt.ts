/**
 * OpenAI speech-to-text: the Whisper file API,
 * `POST https://api.openai.com/v1/audio/transcriptions` (multipart form:
 * `file`, `model`, optional `language`, `response_format: "json"`).
 * Raw PCM is wrapped in a WAV container first, like every vendor here.
 * There is no streaming Whisper endpoint in this kit; streaming
 * transcription lives in the Realtime API (see realtime.ts).
 */
import { VOICE_DEFAULTS, type SttFileInput, type SttProvider, type SttResult } from "@agentproto/voice"
import { DEFAULT_BASE_URL, type OpenAITransport } from "./transport.js"

const D = VOICE_DEFAULTS.providers.openai

export interface OpenAISttConfig extends OpenAITransport {
  /** Read lazily at each call. Default: `process.env.OPENAI_API_KEY`. */
  apiKey?: string | (() => string | undefined)
  modelId?: string
}

export function resolveApiKey(cfg: { apiKey?: string | (() => string | undefined) }): string {
  const k = typeof cfg.apiKey === "function" ? cfg.apiKey() : (cfg.apiKey ?? process.env.OPENAI_API_KEY)
  if (!k) throw new Error("openai: no API key (set OPENAI_API_KEY)")
  return k
}

/** Minimal RIFF/WAVE header for raw mono PCM16. */
export function wavFromPcm16(pcm: Uint8Array, sampleRate: number): Uint8Array {
  const header = new Uint8Array(44)
  const view = new DataView(header.buffer)
  header.set([0x52, 0x49, 0x46, 0x46], 0) // "RIFF"
  view.setUint32(4, 36 + pcm.byteLength, true)
  header.set([0x57, 0x41, 0x56, 0x45], 8) // "WAVE"
  header.set([0x66, 0x6d, 0x74, 0x20], 12) // "fmt "
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, 1, true) // mono
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  header.set([0x64, 0x61, 0x74, 0x61], 36) // "data"
  view.setUint32(40, pcm.byteLength, true)
  const out = new Uint8Array(44 + pcm.byteLength)
  out.set(header, 0)
  out.set(pcm, 44)
  return out
}

export function makeOpenAIStt(cfg: OpenAISttConfig = {}): SttProvider {
  const model = () => cfg.modelId ?? D.sttFileModel.value

  return {
    slug: "openai",
    capabilities: {
      streaming: false,
      file: true,
      partials: false,
      serverEndpointing: false,
      manualCommit: false,
      languages: [],
      sampleRates: [],
    },

    async openStream(): Promise<never> {
      throw new Error("openai stt: no streaming endpoint; use the file API or the realtime session")
    },

    async transcribe(input: SttFileInput, opts?: { language?: string; signal?: AbortSignal }): Promise<SttResult> {
      const apiKey = resolveApiKey(cfg)
      const f = cfg.fetch ?? fetch
      let bytes = input.bytes
      let contentType = input.mimeType
      if (input.mimeType === "audio/pcm") {
        if (!input.sampleRate) throw new Error("openai stt: sampleRate is required for audio/pcm")
        bytes = wavFromPcm16(input.bytes, input.sampleRate)
        contentType = "audio/wav"
      }
      // The API picks the format from the file extension.
      const ext = contentType.split("/")[1]?.split(";")[0] ?? "bin"
      const fileName = `audio.${ext === "mpeg" ? "mp3" : ext}`
      const form = new FormData()
      form.set("file", new File([bytes as BlobPart], fileName, { type: contentType }))
      form.set("model", model())
      form.set("response_format", "json")
      if (opts?.language) form.set("language", opts.language)
      const res = await f(`${cfg.baseUrl ?? DEFAULT_BASE_URL}/v1/audio/transcriptions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}` },
        body: form,
        ...(opts?.signal ? { signal: opts.signal } : {}),
      } as RequestInit)
      if (!res.ok) throw new Error(`openai stt: HTTP ${res.status} ${(await res.text().catch(() => "")).slice(0, 160)}`)
      const r = (await res.json()) as { text?: string; duration?: number; language?: string }
      return { text: r.text ?? "", durationSeconds: r.duration }
    },
  }
}
