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

    const res = await fetch(`${this.baseUrl}/audio/transcriptions`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.apiKey}` },
      body: form,
    })
    if (!res.ok) {
      const body = await res.text().catch(() => "")
      throw new Error(`Whisper STT ${res.status} ${res.statusText}: ${body.slice(0, 200)}`)
    }
    const data = WHISPER_RESPONSE.parse(await res.json())
    const language = normalizeLanguage(data.language)
    return {
      text: (data.text ?? "").trim(),
      ...(language ? { language } : {}),
    }
  }
}

// Whisper returns the language as a full English name ("english",
// "french") in verbose_json — AIP-10 frontmatter wants a BCP-47 code
// ("en", "fr"). Map the common ones; pass through anything that already
// looks like a code; drop the rest (language is optional, and an invalid
// value would fail source validation).
const LANGUAGE_NAME_TO_CODE: Readonly<Record<string, string>> = {
  english: "en", french: "fr", spanish: "es", german: "de", italian: "it",
  portuguese: "pt", dutch: "nl", russian: "ru", japanese: "ja", korean: "ko",
  chinese: "zh", arabic: "ar", hindi: "hi", turkish: "tr", polish: "pl",
  swedish: "sv", norwegian: "no", danish: "da", finnish: "fi", greek: "el",
  hebrew: "he", thai: "th", vietnamese: "vi", indonesian: "id", ukrainian: "uk",
}

function normalizeLanguage(raw: string | undefined): string | undefined {
  if (!raw) return undefined
  const v = raw.trim().toLowerCase()
  if (/^[a-z]{2,3}(-[a-z0-9]+)*$/i.test(v) && v.length <= 5) return v // already a code
  return LANGUAGE_NAME_TO_CODE[v]
}
