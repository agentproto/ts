/**
 * ElevenLabs TTS: a streaming session over the `stream-input` WebSocket, and a
 * one-shot synthesis over HTTP. Output is PCM16 mono at the configured rate.
 *
 * Protocol (as run in production by the studio, `integration/speech`
 * `tts-stream.wrapper.ts`): connect with the key in the `xi-api-key` header,
 * send an initial `{ text: " ", voice_settings, generation_config }` frame,
 * then `{ text }` frames, `{ flush: true }`, and `{ text: "" }` as end of
 * stream. Audio comes back as `{ audio: <base64>, isFinal }`.
 */
import { VOICE_DEFAULTS, type AudioFrame, type TtsProvider, type TtsStream } from "@agentproto/voice"
import { DEFAULT_BASE_URL, DEFAULT_WS_BASE_URL, nodeSocketFactory, type ElevenLabsTransport } from "./transport.js"

const D = VOICE_DEFAULTS.providers.elevenlabs

export interface ElevenLabsTtsConfig extends ElevenLabsTransport {
  /** Read lazily at each call. Default: `process.env.ELEVENLABS_API_KEY`. */
  apiKey?: string | (() => string | undefined)
  modelId?: string
  voiceId?: string
  /** `pcm_<rate>`. Default from the voice defaults. */
  outputFormat?: string
  stability?: number
  similarityBoost?: number
  style?: number
  useSpeakerBoost?: boolean
  chunkLengthSchedule?: readonly number[]
}

export function pcmRateOf(format: string): number {
  const m = /^pcm_(\d+)$/.exec(format)
  if (!m) throw new Error(`elevenlabs: output format "${format}" is not PCM; the voice kit needs pcm_<rate>`)
  return Number(m[1])
}

export function resolveApiKey(cfg: { apiKey?: string | (() => string | undefined) }): string {
  const k = typeof cfg.apiKey === "function" ? cfg.apiKey() : (cfg.apiKey ?? process.env.ELEVENLABS_API_KEY)
  if (!k) throw new Error("elevenlabs: no API key (set ELEVENLABS_API_KEY)")
  return k
}

export function makeElevenLabsTts(cfg: ElevenLabsTtsConfig = {}): TtsProvider {
  const format = cfg.outputFormat ?? D.outputFormat.value
  const rate = pcmRateOf(format)
  const settings = () => ({
    stability: cfg.stability ?? D.stability.value,
    similarity_boost: cfg.similarityBoost ?? D.similarityBoost.value,
    style: cfg.style ?? D.style.value,
    use_speaker_boost: cfg.useSpeakerBoost ?? D.useSpeakerBoost.value,
  })
  const model = () => cfg.modelId ?? D.ttsModel.value
  const voice = (v?: string) => v ?? cfg.voiceId ?? D.voiceId.value

  return {
    slug: "elevenlabs",
    capabilities: {
      streaming: true,
      file: true,
      chunkedInput: true,
      cancel: true,
      languages: [],
      outputSampleRates: [rate],
    },

    async openStream(opts): Promise<TtsStream> {
      const apiKey = resolveApiKey(cfg)
      const socketFactory = cfg.socket ?? nodeSocketFactory
      const url = `${cfg.wsBaseUrl ?? DEFAULT_WS_BASE_URL}/v1/text-to-speech/${voice(opts.voiceId)}/stream-input?model_id=${model()}&output_format=${format}`
      const cbs = { audio: [] as Array<(f: AudioFrame) => void>, done: [] as Array<() => void>, error: [] as Array<(e: Error) => void> }
      let cancelled = false
      let finished = false
      let seq = 0
      let isOpen = false
      const pending: string[] = []
      const sock = socketFactory(url, { headers: { "xi-api-key": apiKey } })

      const send = (obj: unknown) => {
        const s = JSON.stringify(obj)
        if (isOpen) sock.send(s)
        else pending.push(s)
      }
      const finish = () => {
        if (finished || cancelled) return
        finished = true
        cbs.done.forEach(cb => cb())
      }

      sock.on("open", () => {
        isOpen = true
        sock.send(
          JSON.stringify({
            text: " ",
            voice_settings: settings(),
            generation_config: { chunk_length_schedule: [...(cfg.chunkLengthSchedule ?? D.chunkLengthSchedule.value)] },
          }),
        )
        for (const s of pending.splice(0)) sock.send(s)
      })
      sock.on("message", data => {
        if (cancelled) return
        let m: { audio?: string; isFinal?: boolean; error?: string; message?: string }
        try {
          m = JSON.parse(data)
        } catch (err) {
          cbs.error.forEach(cb => cb(err as Error))
          return
        }
        if (m.error || (m.message && !m.audio && !m.isFinal && /error/i.test(m.message))) {
          if (m.error === "input_timeout_exceeded") return finish()
          cbs.error.forEach(cb => cb(new Error(`elevenlabs tts: ${m.error ?? m.message}`)))
          return
        }
        if (m.audio) {
          const bytes = Buffer.from(m.audio, "base64")
          const even = bytes.byteLength - (bytes.byteLength % 2)
          if (even > 0) {
            cbs.audio.forEach(cb =>
              cb({ pcm16: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + even) as ArrayBuffer, sampleRate: rate, sequenceNumber: seq++ }),
            )
          }
        }
        if (m.isFinal) finish()
      })
      sock.on("error", err => {
        if (!cancelled) cbs.error.forEach(cb => cb(err))
      })
      sock.on("close", () => finish())
      opts.signal?.addEventListener("abort", () => stream.cancel(), { once: true })

      const stream: TtsStream = {
        sendText(chunk) {
          if (cancelled || finished || !chunk) return
          send({ text: chunk })
        },
        flush() {
          if (cancelled || finished) return
          send({ text: " ", flush: true })
        },
        end() {
          if (cancelled || finished) return
          send({ text: "" })
        },
        cancel() {
          if (cancelled) return
          cancelled = true
          // Drop what is queued and close: the vendor stops generating when the
          // socket closes, and no audio or done is delivered after this call.
          pending.length = 0
          sock.close(1000)
        },
        on(event: string, cb: never) {
          ;(cbs as Record<string, unknown[]>)[event]!.push(cb)
        },
        async close() {
          if (!cancelled && !finished) sock.close(1000)
        },
      } as TtsStream
      return stream
    },

    async synthesize(input) {
      const apiKey = resolveApiKey(cfg)
      const f = cfg.fetch ?? fetch
      const url = `${cfg.baseUrl ?? DEFAULT_BASE_URL}/v1/text-to-speech/${voice(input.voiceId)}/stream?output_format=${format}`
      const res = await f(url, {
        method: "POST",
        headers: { "xi-api-key": apiKey, "content-type": "application/json" },
        body: JSON.stringify({ text: input.text, model_id: model(), voice_settings: settings() }),
        ...(input.signal ? { signal: input.signal } : {}),
      } as RequestInit)
      if (!res.ok) throw new Error(`elevenlabs tts: HTTP ${res.status} ${(await res.text().catch(() => "")).slice(0, 160)}`)
      const bytes = new Uint8Array(await res.arrayBuffer())
      return { bytes, mimeType: "audio/pcm", durationSeconds: bytes.byteLength / 2 / rate }
    },
  }
}
