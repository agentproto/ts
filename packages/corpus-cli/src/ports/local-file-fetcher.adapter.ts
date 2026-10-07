/**
 * LocalFileFetcher — a FetcherPort for an audio/video file that already
 * sits on disk (`file:///abs/path.mp3` or a bare path such as
 * `/abs/path.mp3`). No yt-dlp, no network fetch: the "URL" IS the file,
 * so this tier just hands it straight to the injected SttPort.
 *
 * Exists because the two video tiers above it (captions, yt-dlp+Whisper)
 * both require a real http(s) URL — a local recording (a downloaded
 * Twitter Space, a Zoom export, …) has neither captions nor a remote host
 * to pull from. Reusing WebImporter/ImporterRunner for it means a local
 * file gets the exact same diarization, slugging, dedup, and corpus
 * materialisation as a YouTube URL — only the "how do we get audio bytes"
 * step differs.
 *
 * Sits ahead of the video/article tiers in the import-web chain: it only
 * claims strings that resolve to a real file on disk, so it's a no-op for
 * every http(s) URL (one `stat` that fails fast) and never competes with
 * them.
 */

import { stat } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { basename, extname } from "node:path"
import type { FetcherPort, FetchedSource } from "@agentproto/corpus"
import type { SttPort } from "./stt.port.js"
import { isSttAuthError } from "./stt.port.js"

export interface LocalFileFetcherOptions {
  readonly stt: SttPort
}

export class LocalFileFetcher implements FetcherPort {
  private readonly stt: SttPort

  constructor(opts: LocalFileFetcherOptions) {
    this.stt = opts.stt
  }

  async fetch(url: string): Promise<FetchedSource | null> {
    const path = await resolveLocalPath(url)
    if (!path) return null // not a local file — let the next tier try

    let t
    try {
      t = await this.stt.transcribe(path)
    } catch (e) {
      // Same contract as the yt-dlp tiers: a transcription failure for
      // THIS file must not read as "not a video" (null) — surface it,
      // except a per-call auth error, which the caller already treats as
      // a skip rather than a batch-wide abort.
      if (isSttAuthError(e)) throw e
      process.stderr.write(`corpus: transcription failed for ${path} — skipped (${msg(e)})\n`)
      return null
    }
    if (!t.text.trim()) return null

    const utterances = t.utterances ?? []
    const diarized = utterances.length > 0
    const speakers = diarized ? new Set(utterances.map(u => u.speaker)).size : 0
    return {
      title: basename(path, extname(path)),
      text: t.text,
      kind: "video",
      ...(t.language ? { language: t.language } : {}),
      via: diarized ? "diarized-transcription" : "transcription",
      ...(diarized
        ? {
            metadata: {
              speech: {
                regime: "spoken",
                diarized: true,
                engine: t.engine ?? "unknown",
                speakers,
                ...(t.speakerLabelsLocalToSegment ? { segmented: true } : {}),
              },
            },
          }
        : {}),
    }
  }
}

/**
 * `file://…` → a real filesystem path; a bare string is tried as-is.
 * Returns `null` (not a thrown error) for anything that isn't an
 * existing regular file — including every http(s) URL — so this tier
 * stays a silent pass-through for everything it doesn't own.
 */
async function resolveLocalPath(url: string): Promise<string | null> {
  let candidate: string
  if (url.startsWith("file://")) {
    try {
      candidate = fileURLToPath(url)
    } catch {
      return null
    }
  } else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) {
    return null // some other URL scheme (http, https, …) — not ours
  } else {
    candidate = url
  }
  try {
    const st = await stat(candidate)
    return st.isFile() ? candidate : null
  } catch {
    return null
  }
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
