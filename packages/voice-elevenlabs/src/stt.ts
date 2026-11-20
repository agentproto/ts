/**
 * ElevenLabs Scribe: a realtime stream over the speech-to-text WebSocket with
 * manual commit, and file transcription over HTTP.
 *
 * Realtime protocol (as run in production by the studio): query
 * `model_id`, `audio_format=pcm_<rate>`, `commit_strategy=manual`; the key in
 * the `xi-api-key` header; audio as
 * `{ message_type: "input_audio_chunk", audio_base_64 }`; a commit as the same
 * frame with `commit: true`. The server answers `partial_transcript` and
 * `committed_transcript`; `scribe_*error` frames are errors.
 */
import { VOICE_DEFAULTS, type SttProvider, type SttStream, type SttTranscript } from "@agentproto/voice"
import { isScribeHallucination } from "./hallucination.js"
import { DEFAULT_BASE_URL, DEFAULT_WS_BASE_URL, nodeSocketFactory, type ElevenLabsTransport } from "./transport.js"
import { resolveApiKey } from "./tts.js"

const D = VOICE_DEFAULTS.providers.elevenlabs

export interface ElevenLabsSttConfig extends ElevenLabsTransport {
  apiKey?: string | (() => string | undefined)
  /** Realtime model. Default from the voice defaults. */
  streamModel?: string
  /** File model. Default from the voice defaults. */
  fileModel?: string
  /** Drop stock subtitle-credit hallucinations on finals. Default true. */
  filterHallucinations?: boolean
}

export function makeElevenLabsStt(cfg: ElevenLabsSttConfig = {}): SttProvider {
  const filter = cfg.filterHallucinations ?? true
  return {
    slug: "elevenlabs",
    capabilities: {
      streaming: true,
      file: true,
      partials: true,
      serverEndpointing: false,
      manualCommit: true,
      languages: [],
      sampleRates: [8000, 16000, 22050, 24000, 44100, 48000],
    },

    async openStream(opts): Promise<SttStream> {
      const apiKey = resolveApiKey(cfg)
      const socketFactory = cfg.socket ?? nodeSocketFactory
      const params = new URLSearchParams({
        model_id: cfg.streamModel ?? D.sttModel.value,
        audio_format: `pcm_${opts.sampleRate}`,
        commit_strategy: "manual",
      })
      if (opts.language) params.set("language_code", opts.language)
      const url = `${cfg.wsBaseUrl ?? DEFAULT_WS_BASE_URL}/v1/speech-to-text/realtime?${params}`
      const cbs = {
        partial: [] as Array<(t: SttTranscript) => void>,
        final: [] as Array<(t: SttTranscript) => void>,
        error: [] as Array<(e: Error) => void>,
        closed: [] as Array<() => void>,
      }
      let isOpen = false
      let closed = false
      const pending: string[] = []
      const sock = socketFactory(url, { headers: { "xi-api-key": apiKey } })
      const send = (obj: unknown) => {
        const s = JSON.stringify(obj)
        if (isOpen) sock.send(s)
        else pending.push(s)
      }
      sock.on("open", () => {
        isOpen = true
        for (const s of pending.splice(0)) sock.send(s)
      })
      sock.on("message", data => {
        let m: { message_type?: string; text?: string; error?: string }
        try {
          m = JSON.parse(data)
        } catch (err) {
          cbs.error.forEach(cb => cb(err as Error))
          return
        }
        switch (m.message_type) {
          case "partial_transcript":
            cbs.partial.forEach(cb => cb({ text: m.text ?? "" }))
            break
          case "committed_transcript": {
            const text = m.text ?? ""
            // A hallucinated final is delivered blank: the engine then treats
            // the utterance as empty and falls back or ignores it.
            cbs.final.forEach(cb => cb({ text: filter && isScribeHallucination(text) ? "" : text }))
            break
          }
          case "scribe_error":
          case "scribe_auth_error":
          case "scribe_quota_exceeded_error":
            cbs.error.forEach(cb => cb(new Error(`elevenlabs stt: ${m.message_type}: ${m.error ?? ""}`)))
            break
          default:
            break
        }
      })
      sock.on("error", err => cbs.error.forEach(cb => cb(err)))
      sock.on("close", () => {
        if (closed) return
        closed = true
        cbs.closed.forEach(cb => cb())
      })
      opts.signal?.addEventListener("abort", () => sock.close(1000), { once: true })

      return {
        pushAudio(frame) {
          if (closed) return
          send({ message_type: "input_audio_chunk", audio_base_64: Buffer.from(frame.pcm16).toString("base64") })
        },
        commit() {
          if (closed) return
          send({ message_type: "input_audio_chunk", audio_base_64: "", commit: true })
        },
        on(event: string, cb: never) {
          ;(cbs as Record<string, unknown[]>)[event]!.push(cb)
        },
        async close() {
          if (closed) return
          closed = true
          sock.close(1000)
          cbs.closed.forEach(cb => cb())
        },
      } as SttStream
    },

    async transcribe(input, opts) {
      const apiKey = resolveApiKey(cfg)
      const f = cfg.fetch ?? fetch
      const form = new FormData()
      form.set("model_id", cfg.fileModel ?? D.sttFileModel.value)
      if (opts?.language) form.set("language_code", opts.language)
      let bytes = input.bytes
      let mime = input.mimeType
      let name = "audio"
      if (input.mimeType === "audio/pcm") {
        if (!input.sampleRate) throw new Error("elevenlabs stt: sampleRate is required for audio/pcm")
        bytes = wavFromPcm16(input.bytes, input.sampleRate)
        mime = "audio/wav"
        name = "audio.wav"
      }
      form.set("file", new Blob([bytes as BlobPart], { type: mime }), name)
      const res = await f(`${cfg.baseUrl ?? DEFAULT_BASE_URL}/v1/speech-to-text`, {
        method: "POST",
        headers: { "xi-api-key": apiKey },
        body: form,
        ...(opts?.signal ? { signal: opts.signal } : {}),
      } as RequestInit)
      if (!res.ok) throw new Error(`elevenlabs stt: HTTP ${res.status} ${(await res.text().catch(() => "")).slice(0, 160)}`)
      const body = (await res.json()) as { text?: string; language_code?: string }
      const text = body.text ?? ""
      return {
        text: filter && isScribeHallucination(text) ? "" : text,
        ...(body.language_code ? { language: body.language_code } : {}),
        ...(input.mimeType === "audio/pcm" && input.sampleRate ? { durationSeconds: input.bytes.byteLength / 2 / input.sampleRate } : {}),
      }
    },
  }
}

/** Wrap mono PCM16 in a WAV container (44-byte header). */
export function wavFromPcm16(pcm: Uint8Array, sampleRate: number): Uint8Array {
  const header = Buffer.alloc(44)
  header.write("RIFF", 0)
  header.writeUInt32LE(36 + pcm.byteLength, 4)
  header.write("WAVEfmt ", 8)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(sampleRate * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write("data", 36)
  header.writeUInt32LE(pcm.byteLength, 40)
  return Buffer.concat([header, pcm])
}
