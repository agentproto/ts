/**
 * AssemblyAiStt — a diarizing SttPort. Where OpenAiWhisperStt returns a
 * flat transcript, this returns SPEAKER-LABELLED text (`Speaker A: … /
 * Speaker B: …`) via AssemblyAI's `speaker_labels`. Use it ad-hoc for
 * multi-speaker videos (interviews, mock interviews, panels, "day in the
 * life") where the content only makes sense if you know who said what.
 *
 * Same `SttPort` contract — the diarized layout lives in `text`, so it
 * drops straight into YtDlpWhisperFetcher without any other change.
 *
 * Flow: upload audio → create transcript(speaker_labels) → poll → format
 * utterances. No 25 MB cap (unlike Whisper), so long videos are fine; the
 * trade-off is latency (~a third of audio duration) — slower than Whisper.
 */

import { readFile } from "node:fs/promises"
import { z } from "zod"
import type { SttPort, Transcript } from "./stt.port.js"

export interface AssemblyAiSttOptions {
  readonly apiKey: string
  readonly baseUrl?: string
  readonly pollIntervalMs?: number
  readonly maxWaitMs?: number
  readonly sleep?: (ms: number) => Promise<void>
}

const UPLOAD_RESPONSE = z.object({ upload_url: z.string() })

const AAI_TRANSCRIPT = z
  .object({
    id: z.string(),
    status: z.enum(["queued", "processing", "completed", "error"]),
    text: z.string().optional(),
    language_code: z.string().optional(),
    error: z.string().optional(),
    utterances: z
      .array(z.object({ speaker: z.string(), text: z.string() }))
      .nullish(),
  })
  .loose()

type AaiTranscript = z.infer<typeof AAI_TRANSCRIPT>

export class AssemblyAiStt implements SttPort {
  private readonly apiKey: string
  private readonly baseUrl: string
  private readonly pollIntervalMs: number
  private readonly maxWaitMs: number
  private readonly sleep: (ms: number) => Promise<void>

  constructor(opts: AssemblyAiSttOptions) {
    this.apiKey = opts.apiKey
    this.baseUrl = (opts.baseUrl ?? "https://api.assemblyai.com/v2").replace(/\/+$/, "")
    this.pollIntervalMs = opts.pollIntervalMs ?? 3000
    this.maxWaitMs = opts.maxWaitMs ?? 15 * 60 * 1000
    this.sleep = opts.sleep ?? ((ms: number) => new Promise(r => setTimeout(r, ms)))
  }

  async transcribe(audioPath: string): Promise<Transcript> {
    const bytes = await readFile(audioPath)

    // 1. Upload the audio bytes.
    const up = await fetch(`${this.baseUrl}/upload`, {
      method: "POST",
      headers: { authorization: this.apiKey, "content-type": "application/octet-stream" },
      body: bytes,
    })
    if (!up.ok) throw new Error(`AssemblyAI upload ${up.status}: ${(await up.text()).slice(0, 200)}`)
    const { upload_url } = UPLOAD_RESPONSE.parse(await up.json())

    // 2. Create a diarized transcript job.
    const created = await this.post("/transcript", {
      audio_url: upload_url,
      speaker_labels: true,
      language_detection: true,
    })
    const id = created.id

    // 3. Poll until done.
    const deadline = this.maxWaitMs
    let waited = 0
    let job = created
    while (job.status !== "completed" && job.status !== "error") {
      if (waited >= deadline) throw new Error(`AssemblyAI transcript ${id} timed out after ${deadline} ms`)
      await this.sleep(this.pollIntervalMs)
      waited += this.pollIntervalMs
      job = await this.get(`/transcript/${id}`)
    }
    if (job.status === "error") throw new Error(`AssemblyAI transcript failed: ${job.error ?? "unknown"}`)

    return {
      text: formatDiarized(job),
      ...(job.language_code ? { language: job.language_code } : {}),
    }
  }

  private async post(path: string, body: unknown): Promise<AaiTranscript> {
    const r = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: { authorization: this.apiKey, "content-type": "application/json" },
      body: JSON.stringify(body),
    })
    if (!r.ok) throw new Error(`AssemblyAI POST ${path} ${r.status}: ${(await r.text()).slice(0, 200)}`)
    return AAI_TRANSCRIPT.parse(await r.json())
  }

  private async get(path: string): Promise<AaiTranscript> {
    const r = await fetch(`${this.baseUrl}${path}`, { headers: { authorization: this.apiKey } })
    if (!r.ok) throw new Error(`AssemblyAI GET ${path} ${r.status}: ${(await r.text()).slice(0, 200)}`)
    return AAI_TRANSCRIPT.parse(await r.json())
  }
}

/** Join utterances as `Speaker A: …` blocks; fall back to flat text. */
function formatDiarized(job: AaiTranscript): string {
  if (job.utterances && job.utterances.length > 0) {
    return job.utterances
      .map(u => `Speaker ${u.speaker}: ${u.text.trim()}`)
      .join("\n\n")
      .trim()
  }
  return (job.text ?? "").trim()
}
