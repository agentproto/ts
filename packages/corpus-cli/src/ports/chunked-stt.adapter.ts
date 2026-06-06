/**
 * ChunkedStt — a SttPort decorator that makes a capped engine handle
 * arbitrarily long audio. Whisper rejects files over 25 MB, so a
 * multi-hour talk (full course, masterclass, panel) can't be sent in one
 * request. This wrapper splits oversized audio into time segments with
 * ffmpeg, transcribes each through the wrapped engine, and concatenates
 * the text back into a single transcript.
 *
 *   transcribe(path) →  ≤cap ? base.transcribe(path)
 *                       : ffmpeg segment → base.transcribe(eachPart) → join
 *
 * The cap is a vendor concern (Whisper's limit), so handling it belongs in
 * the STT layer rather than the fetcher — the fetcher stays pure and the
 * concrete `OpenAiWhisperStt` stays a single-request transcriber. Splitting
 * is injected as `split` so the decorator is unit-testable with a fake
 * splitter + fake base engine — no ffmpeg, no network.
 *
 * Segmenting uses `-c copy` (stream copy, no re-encode): fast, and each
 * segment is a self-contained valid file. At the fetcher's 64 kbps a 20-min
 * segment is ~9.6 MB — comfortably under the 25 MB cap with margin for
 * VBR drift.
 */

import { execFile } from "node:child_process"
import { mkdtemp, readdir, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { extname, join } from "node:path"
import { promisify } from "node:util"
import type { SttPort, Transcript } from "./stt.port.js"

const execFileAsync = promisify(execFile)

/**
 * Split a local audio file into ≤`segmentSeconds` parts inside `outDir`,
 * returning the segment paths in playback order. Injectable for tests.
 */
export type AudioSplitter = (
  audioPath: string,
  segmentSeconds: number,
  outDir: string
) => Promise<string[]>

export interface ChunkedSttOptions {
  /** The engine each (sub-cap) part is transcribed through. */
  readonly base: SttPort
  /**
   * Split anything strictly larger than this. Default 24 MB — just under
   * Whisper's 25 MB hard cap so VBR drift never pushes a part over.
   */
  readonly maxBytes?: number
  /** Segment length when splitting. Default 1200 s (20 min). */
  readonly segmentSeconds?: number
  /** Defaults to an ffmpeg segment-muxer splitter. */
  readonly split?: AudioSplitter
  /** Path to the ffmpeg binary (default: "ffmpeg" on PATH). */
  readonly ffmpegBin?: string
}

const DEFAULT_MAX_BYTES = 24 * 1024 * 1024
const DEFAULT_SEGMENT_SECONDS = 1200

export class ChunkedStt implements SttPort {
  private readonly base: SttPort
  private readonly maxBytes: number
  private readonly segmentSeconds: number
  private readonly split: AudioSplitter

  constructor(opts: ChunkedSttOptions) {
    this.base = opts.base
    this.maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES
    this.segmentSeconds = opts.segmentSeconds ?? DEFAULT_SEGMENT_SECONDS
    this.split = opts.split ?? defaultFfmpegSplitter(opts.ffmpegBin ?? "ffmpeg")
  }

  async transcribe(audioPath: string): Promise<Transcript> {
    const { size } = await stat(audioPath)
    if (size <= this.maxBytes) return this.base.transcribe(audioPath)

    const dir = await mkdtemp(join(tmpdir(), "corpus-stt-chunk-"))
    try {
      const parts = await this.split(audioPath, this.segmentSeconds, dir)
      if (parts.length === 0) {
        // Splitter produced nothing — fall back to a single attempt so the
        // base engine surfaces its own (clear) over-cap error rather than
        // us silently dropping the source.
        return this.base.transcribe(audioPath)
      }
      const texts: string[] = []
      let language: string | undefined
      let failed = 0
      let firstErr: unknown
      for (const part of parts) {
        try {
          const t = await this.base.transcribe(part)
          if (t.text.trim()) texts.push(t.text.trim())
          language ??= t.language
        } catch (e) {
          // One segment failing (after the base engine's own retries) must
          // not discard the whole multi-hour transcript — keep the rest.
          failed++
          firstErr ??= e
        }
      }
      // Every segment failing usually means a systemic error (auth, quota) —
      // rethrow so the caller can surface/skip it, rather than silently
      // writing an empty transcript.
      if (texts.length === 0) {
        throw firstErr ?? new Error("all audio segments failed transcription")
      }
      if (failed > 0) {
        process.stderr.write(
          `corpus: ${failed}/${parts.length} audio segments failed — partial transcript\n`
        )
      }
      return {
        text: texts.join("\n\n"),
        ...(language ? { language } : {}),
      }
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  }
}

// ── Default ffmpeg segment-muxer splitter ───────────────────────────

function defaultFfmpegSplitter(bin: string): AudioSplitter {
  return async (audioPath, segmentSeconds, outDir) => {
    const ext = extname(audioPath) || ".mp3"
    await execFileAsync(
      bin,
      [
        "-hide_banner", "-loglevel", "error",
        "-i", audioPath,
        "-f", "segment",
        "-segment_time", String(segmentSeconds),
        "-c", "copy",
        join(outDir, `part%03d${ext}`),
      ],
      { maxBuffer: 16 * 1024 * 1024 }
    )
    // ffmpeg names parts part000, part001, … — lexical sort = playback order.
    const files = (await readdir(outDir))
      .filter(f => f.startsWith("part") && f.endsWith(ext))
      .sort()
    return files.map(f => join(outDir, f))
  }
}
