/**
 * YtDlpWhisperFetcher — a FetcherPort for video URLs that does NOT rely
 * on captions (YouTube's caption/transcript APIs are pot/SABR-gated and
 * frequently unavailable). Instead it pulls the audio with yt-dlp and
 * transcribes it with an injected SttPort (Whisper). Captions-independent
 * and robust: works whether or not the video has subtitles.
 *
 *   video URL → yt-dlp -f bestaudio -x (mp3) → SttPort.transcribe → text
 *
 * yt-dlp handles the pot token / SABR negotiation / signature itself, so
 * no browser or cookies are needed for public videos. Non-video URLs
 * resolve to `null` so this fetcher composes ahead of a readability
 * fetcher (see CompositeFetcher).
 *
 * The yt-dlp invocation is injected as `download` so the adapter is unit-
 * testable with a fake downloader + fake SttPort — no binary, no network.
 */

import { execFile } from "node:child_process"
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { z } from "zod"
import type { FetcherPort, FetchedSource } from "@agentproto/corpus"
import type { SttPort } from "./stt.port.js"
import { isVideoUrl } from "./video-hosts.js"

const execFileAsync = promisify(execFile)

/** yt-dlp's `.info.json` — only the fields we use. */
const YTDLP_INFO = z
  .object({ title: z.string().optional(), language: z.string().optional() })
  .loose()

export interface AudioDownload {
  readonly audioPath: string
  readonly title: string
  readonly language?: string
  /** Remove the temp working dir. Always called by the fetcher. */
  cleanup(): Promise<void>
}

/** Pull a URL's audio to a local file. Injectable for tests. */
export type AudioDownloader = (url: string) => Promise<AudioDownload>

export interface YtDlpWhisperFetcherOptions {
  readonly stt: SttPort
  /** Defaults to a yt-dlp subprocess downloader. */
  readonly download?: AudioDownloader
  /** Path to the yt-dlp binary (default: "yt-dlp" on PATH). */
  readonly ytDlpBin?: string
  /** Treat these hostnames as video (in addition to the YouTube/Vimeo set). */
  readonly extraVideoHosts?: readonly string[]
}

export class YtDlpWhisperFetcher implements FetcherPort {
  private readonly stt: SttPort
  private readonly download: AudioDownloader
  private readonly extraHosts: ReadonlySet<string> | undefined

  constructor(opts: YtDlpWhisperFetcherOptions) {
    this.stt = opts.stt
    this.download =
      opts.download ?? defaultYtDlpDownloader(opts.ytDlpBin ?? "yt-dlp")
    this.extraHosts = opts.extraVideoHosts
      ? new Set(opts.extraVideoHosts)
      : undefined
  }

  async fetch(url: string): Promise<FetchedSource | null> {
    if (!isVideoUrl(url, this.extraHosts)) return null // let a readability fetcher handle it

    let dl: AudioDownload
    try {
      dl = await this.download(url)
    } catch {
      // Per-video download failure (geo-block, private, removed) → skip,
      // don't abort the batch. Hard config errors (STT auth) still throw.
      return null
    }
    try {
      const t = await this.stt.transcribe(dl.audioPath)
      if (!t.text.trim()) return null
      return {
        title: dl.title || url,
        text: t.text,
        kind: "video",
        ...(t.language ?? dl.language
          ? { language: t.language ?? dl.language }
          : {}),
        via: "transcription",
      }
    } finally {
      await dl.cleanup().catch(() => {})
    }
  }
}

// ── Default yt-dlp subprocess downloader ────────────────────────────

function defaultYtDlpDownloader(bin: string): AudioDownloader {
  return async (url: string): Promise<AudioDownload> => {
    const dir = await mkdtemp(join(tmpdir(), "corpus-ytdlp-"))
    const cleanup = () => rm(dir, { recursive: true, force: true })
    try {
      await execFileAsync(
        bin,
        [
          "-f", "bestaudio",
          "-x", "--audio-format", "mp3", "--audio-quality", "64K",
          "--no-playlist", "--no-progress",
          "--write-info-json",
          "-o", join(dir, "track.%(ext)s"),
          url,
        ],
        { maxBuffer: 16 * 1024 * 1024 }
      )
      const files = await readdir(dir)
      const audio = files.find(f => f === "track.mp3") ??
        files.find(f => /\.(mp3|m4a|opus|webm|ogg|wav)$/i.test(f))
      if (!audio) throw new Error("yt-dlp produced no audio file")

      let title = url
      let language: string | undefined
      const infoName = files.find(f => f.endsWith(".info.json"))
      if (infoName) {
        try {
          const info = YTDLP_INFO.parse(
            JSON.parse(await readFile(join(dir, infoName), "utf-8"))
          )
          if (info.title) title = info.title
          if (info.language) language = info.language
        } catch {
          // info json optional — fall back to url as title
        }
      }
      return {
        audioPath: join(dir, audio),
        title,
        ...(language ? { language } : {}),
        cleanup,
      }
    } catch (e) {
      await cleanup().catch(() => {})
      throw e
    }
  }
}
