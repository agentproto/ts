/**
 * AssemblyAI TTS-1: a streaming session over
 * `wss://tts.us.assemblyai.com/v1/ws` and a one-shot synthesis over
 * `POST https://tts.us.assemblyai.com/v1/speech`.
 *
 * Protocol read from assemblyai.com/docs on 2026-11-21: the session is
 * configured entirely in the query string (`voice_id`, `model_id`,
 * `language`, `sample_rate`, `encoding`, ...), the key goes in the
 * `Authorization` header. The server sends `Begin` first; wait for it
 * before sending text. Client frames: `Generate {text}`, `Flush`, `Cancel`
 * (barge-in), `KeepAlive`, `Terminate` (implicit flush, then `Termination`
 * and close 1000). Server frames: `Audio {audio: base64, flush_id}`,
 * `FlushDone`, `Cancelled`, `WordBoundaries`, `Termination`, `Error`.
 * Output is raw PCM16 mono at the requested rate.
 */
import { VOICE_DEFAULTS, type AudioFrame, type TtsProvider, type TtsStream, type TtsStreamOptions } from "@agentproto/voice"
import { DEFAULT_TTS_BASE_URL, DEFAULT_TTS_WS_BASE_URL, nodeSocketFactory, type AssemblyAITransport } from "./transport.js"
import { resolveApiKey } from "./stt.js"

const D = VOICE_DEFAULTS.providers.assemblyai

/** The six languages TTS-1 speaks (docs 2026-11-21), as BCP-47. */
export const TTS_LANGUAGES = ["en", "es", "fr", "de", "it", "pt"] as const
export const TTS_SAMPLE_RATES = [8000, 16000, 22050, 24000, 44100, 48000] as const

/** The API takes the language as its full name; BCP-47 codes are mapped. */
const LANGUAGE_NAMES: Record<string, string> = {
  en: "english", es: "spanish", fr: "french", de: "german", it: "italian", pt: "portuguese",
}
export function languageName(lang: string | undefined): string | undefined {
  if (!lang) return undefined
  const lower = lang.toLowerCase()
  const mapped = LANGUAGE_NAMES[lower] ?? (Object.values(LANGUAGE_NAMES).includes(lower) ? lower : undefined)
  if (!mapped) {
    throw new Error(`assemblyai tts: language ${lang} not supported (one of ${TTS_LANGUAGES.join(",")} or their full names)`)
  }
  return mapped
}

export interface AssemblyAITtsConfig extends AssemblyAITransport {
  apiKey?: string | (() => string | undefined)
  modelId?: string
  voiceId?: string
  language?: string
  sampleRate?: number
}

export function makeAssemblyAITts(cfg: AssemblyAITtsConfig = {}): TtsProvider {
  const rate = cfg.sampleRate ?? D.ttsSampleRate.value
  if (!(TTS_SAMPLE_RATES as readonly number[]).includes(rate)) {
    throw new Error(`assemblyai tts: sample rate ${rate} not in ${TTS_SAMPLE_RATES.join(",")}`)
  }
  const encoding = D.ttsEncoding.value
  const model = () => cfg.modelId ?? D.ttsModel.value
  const voice = (v?: string) => v ?? cfg.voiceId ?? D.ttsVoiceId.value
  const language = (l?: string) => languageName(l ?? cfg.language ?? D.ttsLanguage.value)

  return {
    slug: "assemblyai",
    capabilities: {
      streaming: true,
      file: true,
      chunkedInput: true,
      cancel: true,
      languages: [...TTS_LANGUAGES],
      outputSampleRates: [...TTS_SAMPLE_RATES],
    },

    async openStream(opts: TtsStreamOptions): Promise<TtsStream> {
      const apiKey = resolveApiKey(cfg)
      const socketFactory = cfg.socket ?? nodeSocketFactory
      const effectiveRate = opts.sampleRate ?? rate
      const params = new URLSearchParams({ sample_rate: String(effectiveRate), encoding })
      const v = voice(opts.voiceId)
      if (v) params.set("voice_id", v)
      const m = model()
      if (m) params.set("model_id", m)
      const lang = language(opts.language)
      if (lang) params.set("language", lang)
      const url = `${cfg.ttsWsBaseUrl ?? DEFAULT_TTS_WS_BASE_URL}?${params.toString()}`

      const cbs = { audio: [] as Array<(f: AudioFrame) => void>, done: [] as Array<() => void>, error: [] as Array<(e: Error) => void> }
      let cancelled = false
      let finished = false
      let began = false
      let closed = false
      let seq = 0
      const pending: string[] = []
      const sock = socketFactory(url, { headers: { Authorization: apiKey } })
      const send = (obj: unknown) => {
        const s = JSON.stringify(obj)
        // The docs say to wait for Begin before sending text.
        if (began) sock.send(s)
        else pending.push(s)
      }
      const finish = () => {
        if (finished || cancelled) return
        finished = true
        cbs.done.forEach(cb => cb())
      }

      sock.on("open", () => {})
      sock.on("message", data => {
        if (closed || cancelled) return
        let m: Record<string, unknown>
        try {
          m = JSON.parse(data)
        } catch (err) {
          cbs.error.forEach(cb => cb(err as Error))
          return
        }
        const type = m.type as string | undefined
        if (type === "Begin") {
          began = true
          for (const s of pending.splice(0)) sock.send(s)
        } else if (type === "Audio") {
          const b64 = m.audio
          if (typeof b64 !== "string" || !b64) return
          const bytes = Buffer.from(b64, "base64")
          const even = bytes.byteLength - (bytes.byteLength % 2)
          if (even > 0) {
            cbs.audio.forEach(cb =>
              cb({ pcm16: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + even) as ArrayBuffer, sampleRate: effectiveRate, sequenceNumber: seq++ }),
            )
          }
        } else if (type === "Termination") {
          finish()
        } else if (type === "Error") {
          const msg = typeof m.error === "string" ? m.error : `assemblyai tts error ${m.error_code ?? type}`
          cbs.error.forEach(cb => cb(new Error(`assemblyai tts: ${msg}`)))
        }
        // FlushDone, Cancelled, WordBoundaries: no stream event.
      })
      sock.on("error", err => {
        if (!closed && !cancelled) cbs.error.forEach(cb => cb(err))
      })
      sock.on("close", () => {
        closed = true
        finish()
      })
      opts.signal?.addEventListener("abort", () => stream.cancel(), { once: true })

      const stream: TtsStream = {
        sendText(chunk) {
          if (cancelled || finished || !chunk) return
          send({ type: "Generate", text: chunk })
        },
        flush() {
          if (cancelled || finished) return
          send({ type: "Flush" })
        },
        end() {
          if (cancelled || finished) return
          // Terminate performs the implicit flush: the remaining audio is
          // delivered, then Termination, then the socket closes.
          send({ type: "Terminate" })
        },
        cancel() {
          if (cancelled) return
          cancelled = true
          // After this call no audio and no done is delivered; the vendor's
          // Cancelled answer and any in-flight audio tail are dropped.
          pending.length = 0
          if (began && !closed) sock.send(JSON.stringify({ type: "Cancel" }))
          sock.close(1000)
        },
        on(event: string, cb: never) {
          ;(cbs as Record<string, unknown[]>)[event]!.push(cb)
        },
        async close() {
          if (closed) return
          if (!cancelled && !finished && began) sock.send(JSON.stringify({ type: "Terminate" }))
          sock.close(1000)
        },
      }
      return stream
    },

    async synthesize(input: { text: string; voiceId?: string; language?: string; signal?: AbortSignal }) {
      const apiKey = resolveApiKey(cfg)
      const f = cfg.fetch ?? fetch
      const url = `${cfg.ttsBaseUrl ?? DEFAULT_TTS_BASE_URL}/v1/speech`
      const body: Record<string, unknown> = {
        text: input.text,
        model_id: model(),
        sample_rate: rate,
        encoding,
        container: "raw",
      }
      const v = voice(input.voiceId)
      if (v) body.voice_id = v
      const lang = language(input.language)
      if (lang) body.language = lang
      const res = await f(url, {
        method: "POST",
        headers: { Authorization: apiKey, "content-type": "application/json" },
        body: JSON.stringify(body),
        ...(input.signal ? { signal: input.signal } : {}),
      } as RequestInit)
      if (!res.ok) throw new Error(`assemblyai tts: HTTP ${res.status} ${(await res.text().catch(() => "")).slice(0, 160)}`)
      const bytes = new Uint8Array(await res.arrayBuffer())
      return { bytes, mimeType: "audio/pcm", durationSeconds: bytes.byteLength / 2 / rate }
    },
  }
}
