/**
 * SttPort — speech-to-text boundary the YtDlpWhisperFetcher consumes.
 *
 * Keeps the fetcher pure of any STT-vendor specifics: it hands a local
 * audio file path to `transcribe()` and gets back text. The CLI wires a
 * concrete impl (OpenAI Whisper here; swap for a self-hosted whisper.cpp
 * or Deepgram impl without touching the fetcher).
 */

import { readFile } from "node:fs/promises"
import { basename } from "node:path"
import { normalizeLanguageTag } from "@agentproto/corpus"
import { z } from "zod"

/** The Whisper verbose_json fields we read. */
const WHISPER_RESPONSE = z
  .object({ text: z.string().optional(), language: z.string().optional() })
  .loose()

export interface Transcript {
  readonly text: string
  /** BCP-47 language, when the engine detects it. */
  readonly language?: string
}

export interface SttPort {
  transcribe(audioPath: string): Promise<Transcript>
}

const WHISPER_MAX_BYTES = 25 * 1024 * 1024 // OpenAI hard cap

export interface OpenAiWhisperSttOptions {
  readonly apiKey: string
  /** Default "whisper-1". */
  readonly model?: string
  /** Override base URL (proxy / Azure). Default OpenAI. */
  readonly baseUrl?: string
}

/**
 * OpenAI Whisper STT. Posts the audio file to /audio/transcriptions with
 * `response_format=verbose_json` so we recover the detected language.
 *
 * Files above OpenAI's 25 MB cap throw a clear error — the caller should
 * have downloaded at a lower bitrate (the fetcher uses 64 kbps mono) or
 * chunk long media. We surface the size rather than letting the API 413.
 */
export class OpenAiWhisperStt implements SttPort {
  private readonly apiKey: string
  private readonly model: string
  private readonly baseUrl: string

  constructor(opts: OpenAiWhisperSttOptions) {
    this.apiKey = opts.apiKey
    this.model = opts.model ?? "whisper-1"
    this.baseUrl = (opts.baseUrl ?? "https://api.openai.com/v1").replace(/\/+$/, "")
  }

  async transcribe(audioPath: string): Promise<Transcript> {
    const bytes = await readFile(audioPath)
    if (bytes.byteLength > WHISPER_MAX_BYTES) {
      throw new Error(
        `audio ${basename(audioPath)} is ${(bytes.byteLength / 1024 / 1024).toFixed(1)} MB — over Whisper's 25 MB cap. Lower the bitrate or chunk the media.`
      )
    }
    const form = new FormData()
    form.append("file", new Blob([bytes]), basename(audioPath))
    form.append("model", this.model)
    form.append("response_format", "verbose_json")

    const res = await this.postWithRetry(form)
    if (!res.ok) {
      const body = await res.text().catch(() => "")
      throw new Error(`Whisper STT ${res.status} ${res.statusText}: ${body.slice(0, 200)}`)
    }
    const data = WHISPER_RESPONSE.parse(await res.json())
    const language = normalizeLanguageTag(data.language)
    return {
      text: (data.text ?? "").trim(),
      ...(language ? { language } : {}),
    }
  }

  /**
   * POST the audio with bounded retry. Transcribing a long talk fans out
   * into many segment uploads (see ChunkedStt), so a single transient
   * network blip ("fetch failed") or a 429 / 5xx must not abort the whole
   * batch. Network errors and retryable statuses back off and retry;
   * client errors (401 auth, 400 bad request) return immediately so a real
   * misconfiguration still surfaces loudly.
   */
  private async postWithRetry(form: FormData, attempts = 4): Promise<Response> {
    const url = `${this.baseUrl}/audio/transcriptions`
    let lastErr: unknown
    for (let i = 0; i < attempts; i++) {
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { authorization: `Bearer ${this.apiKey}` },
          body: form,
        })
        if (res.status !== 429 && res.status < 500) return res
        lastErr = new Error(`Whisper STT ${res.status} ${res.statusText}`)
      } catch (e) {
        lastErr = e // network-level failure (undici "fetch failed", reset, timeout)
      }
      if (i < attempts - 1) await delay(500 * 2 ** i) // 0.5s, 1s, 2s
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
  }
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
