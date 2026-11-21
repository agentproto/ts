/**
 * AssemblyAI speech-to-text: Universal Streaming v3 over
 * `wss://streaming.assemblyai.com/v3/ws` (binary PCM frames up, JSON control
 * frames, `Turn` messages down with `end_of_turn` marking a final), and the
 * file REST API (`POST /v2/upload`, then `POST /v2/transcript` polled at
 * `GET /v2/transcript/:id`).
 *
 * Protocol read from assemblyai.com/docs on 2026-11-21: the key goes in the
 * `Authorization` header (raw key; `Bearer` also accepted), session
 * parameters go in the query string (`sample_rate`, `encoding`,
 * `language_codes`, `speech_model`, ...). The server sends `Begin` first;
 * the client sends binary audio frames, `{"type":"ForceEndpoint"}` for a
 * final on demand, `{"type":"Terminate"}` to end. `Turn` with
 * `end_of_turn: true` is a final, `end_of_turn: false` a partial.
 */
import { VOICE_DEFAULTS, type AudioFrame, type SttFileInput, type SttProvider, type SttResult, type SttStream, type SttStreamOptions } from "@agentproto/voice"
import { DEFAULT_BASE_URL, DEFAULT_WS_BASE_URL, nodeSocketFactory, type AssemblyAITransport } from "./transport.js"

const D = VOICE_DEFAULTS.providers.assemblyai

export interface AssemblyAISttConfig extends AssemblyAITransport {
  /** Read lazily at each call. Default: `process.env.ASSEMBLYAI_API_KEY`. */
  apiKey?: string | (() => string | undefined)
  /** `speech_model` query parameter. Default: omitted (server default). */
  speechModel?: string
  /** Poll interval for the file transcript. Default 500 ms. */
  pollMs?: number
}

export function resolveApiKey(cfg: { apiKey?: string | (() => string | undefined) }): string {
  const k = typeof cfg.apiKey === "function" ? cfg.apiKey() : (cfg.apiKey ?? process.env.ASSEMBLYAI_API_KEY)
  if (!k) throw new Error("assemblyai: no API key (set ASSEMBLYAI_API_KEY)")
  return k
}

/** Minimal RIFF/WAVE header for raw mono PCM16 (the file API sniffs containers, not raw PCM). */
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
  view.setUint32(28, sampleRate * 2, true) // byte rate
  view.setUint16(32, 2, true) // block align
  view.setUint16(34, 16, true) // bits per sample
  header.set([0x64, 0x61, 0x74, 0x61], 36) // "data"
  view.setUint32(40, pcm.byteLength, true)
  const out = new Uint8Array(44 + pcm.byteLength)
  out.set(header, 0)
  out.set(pcm, 44)
  return out
}

export function makeAssemblyAIStt(cfg: AssemblyAISttConfig = {}): SttProvider {
  const encoding = D.sttEncoding.value

  return {
    slug: "assemblyai",
    capabilities: {
      streaming: true,
      file: true,
      partials: true,
      serverEndpointing: true,
      manualCommit: true,
      languages: [],
      // Advisory, non-exhaustive: v3 accepts any integer 8000-96000 for pcm_s16le
      // (docs 2026-11-21); these are the common rates we recommend.
      sampleRates: [8000, 16000, 24000, 48000],
    },

    async openStream(opts: SttStreamOptions): Promise<SttStream> {
      const apiKey = resolveApiKey(cfg)
      const socketFactory = cfg.socket ?? nodeSocketFactory
      const params = new URLSearchParams({ sample_rate: String(opts.sampleRate), encoding })
      const model = cfg.speechModel ?? D.sttSpeechModel.value
      if (model) params.set("speech_model", model)
      if (opts.language) params.set("language_codes", opts.language)
      const url = `${cfg.wsBaseUrl ?? DEFAULT_WS_BASE_URL}?${params.toString()}`

      const cbs = {
        partial: [] as Array<(t: { text: string }) => void>,
        final: [] as Array<(t: { text: string }) => void>,
        error: [] as Array<(e: Error) => void>,
        closed: [] as Array<() => void>,
      }
      let closed = false
      let isOpen = false
      const pending: Array<string | Uint8Array> = []
      const sock = socketFactory(url, { headers: { Authorization: apiKey } })
      const send = (data: string | Uint8Array) => {
        if (isOpen) sock.send(data)
        else pending.push(data)
      }
      const finish = () => {
        if (closed) return
        closed = true
        cbs.closed.forEach(cb => cb())
      }

      sock.on("open", () => {
        isOpen = true
        for (const p of pending.splice(0)) sock.send(p)
      })
      sock.on("message", data => {
        if (closed) return
        let m: Record<string, unknown>
        try {
          m = JSON.parse(data)
        } catch (err) {
          cbs.error.forEach(cb => cb(err as Error))
          return
        }
        const type = m.type as string | undefined
        if (type === "Turn") {
          const text = typeof m.transcript === "string" ? m.transcript : ""
          const t = { text }
          if (m.end_of_turn === true) cbs.final.forEach(cb => cb(t))
          else cbs.partial.forEach(cb => cb(t))
        } else if (type === "Termination") {
          finish()
        } else if (type === "Error") {
          const msg = typeof m.error === "string" ? m.error : `assemblyai stt error ${m.error_code ?? type}`
          cbs.error.forEach(cb => cb(new Error(`assemblyai stt: ${msg}`)))
        }
        // Begin, SpeechStarted, Heartbeat: no stream event.
      })
      sock.on("error", err => {
        if (!closed) cbs.error.forEach(cb => cb(err))
      })
      sock.on("close", () => finish())
      opts.signal?.addEventListener("abort", () => stream.close(), { once: true })

      const stream: SttStream = {
        pushAudio(frame: AudioFrame) {
          if (closed) return
          send(new Uint8Array(frame.pcm16))
        },
        commit() {
          if (closed) return
          send(JSON.stringify({ type: "ForceEndpoint" }))
        },
        on(event: string, cb: never) {
          ;(cbs as Record<string, unknown[]>)[event]!.push(cb)
        },
        async close() {
          if (closed) return
          send(JSON.stringify({ type: "Terminate" }))
          // The server answers Termination and closes; do not hang if it does not.
          sock.close(1000)
          finish()
        },
      }
      return stream
    },

    async transcribe(input: SttFileInput, opts?: { language?: string; signal?: AbortSignal }): Promise<SttResult> {
      const apiKey = resolveApiKey(cfg)
      const f = cfg.fetch ?? fetch
      const base = cfg.baseUrl ?? DEFAULT_BASE_URL
      const headers = { Authorization: apiKey }

      let bytes = input.bytes
      let contentType = input.mimeType
      if (input.mimeType === "audio/pcm") {
        if (!input.sampleRate) throw new Error("assemblyai stt: sampleRate is required for audio/pcm")
        bytes = wavFromPcm16(input.bytes, input.sampleRate)
        contentType = "audio/wav"
      }

      // 1. Upload the audio.
      const upRes = await f(`${base}/v2/upload`, {
        method: "POST",
        headers: { ...headers, "content-type": contentType },
        body: bytes,
        ...(opts?.signal ? { signal: opts.signal } : {}),
      } as RequestInit)
      if (!upRes.ok) throw new Error(`assemblyai stt: upload HTTP ${upRes.status} ${(await upRes.text().catch(() => "")).slice(0, 160)}`)
      const up = (await upRes.json()) as { upload_url?: string }
      if (!up.upload_url) throw new Error("assemblyai stt: upload returned no upload_url")

      // 2. Create the transcript.
      const body: Record<string, unknown> = { audio_url: up.upload_url }
      const language = opts?.language ?? D.sttFileLanguageCode.value
      if (language) body.language_code = language
      const createRes = await f(`${base}/v2/transcript`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify(body),
        ...(opts?.signal ? { signal: opts.signal } : {}),
      } as RequestInit)
      if (!createRes.ok) throw new Error(`assemblyai stt: transcript HTTP ${createRes.status} ${(await createRes.text().catch(() => "")).slice(0, 160)}`)
      const created = (await createRes.json()) as { id?: string; status?: string; error?: string }
      if (!created.id) throw new Error("assemblyai stt: transcript returned no id")

      // 3. Poll until completed or error.
      const pollMs = cfg.pollMs ?? 500
      const deadline = Date.now() + 120_000
      for (;;) {
        if (Date.now() > deadline) throw new Error("assemblyai stt: transcript poll timed out")
        await new Promise(r => setTimeout(r, pollMs))
        const res = await f(`${base}/v2/transcript/${created.id}`, {
          method: "GET",
          headers,
          ...(opts?.signal ? { signal: opts.signal } : {}),
        } as RequestInit)
        if (!res.ok) throw new Error(`assemblyai stt: poll HTTP ${res.status}`)
        const t = (await res.json()) as { status?: string; text?: string; error?: string; audio_duration?: number; audio_duration_seconds?: number; language_code?: string }
        if (t.status === "completed") {
          return { text: t.text ?? "", language: t.language_code, durationSeconds: t.audio_duration_seconds ?? t.audio_duration }
        }
        if (t.status === "error") throw new Error(`assemblyai stt: ${t.error ?? "transcription failed"}`)
      }
    },
  }
}
