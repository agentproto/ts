/**
 * YtDlpWhisperFetcher — a FetcherPort for video URLs that does NOT rely
 * on captions (YouTube's caption/transcript APIs are pot/SABR-gated and
 * frequently unavailable). Instead it pulls the audio with yt-dlp and
 * transcribes it with an injected SttPort (Whisper). Captions-independent
 * and robust: works whether or not the video has subtitles.
 *
 *   video URL → yt-dlp -f bestaudio/best -x (mp3) → SttPort.transcribe → text
 *
 * Modern YouTube requires three workarounds beyond a plain yt-dlp call:
 *   • `-f bestaudio/best` — many videos no longer expose a standalone
 *     bestaudio format; the /best fallback avoids "format not available".
 *   • `--remote-components ejs:github` — solves the nsig "n challenge"
 *     that otherwise yields "Only images are available".
 *   • `--extractor-args youtube:player_client=<client>` — both the android
 *     client (unauthenticated) and the web_creator client (authenticated)
 *     fall back to progressive format 18, which requires no PO token and
 *     avoids the HTTP 403 that DASH segment requests trigger. The client is
 *     chosen based on whether cookies are provided: android does not support
 *     cookie auth (yt-dlp skips it when cookies are present), so web_creator
 *     is used instead for authenticated sessions.
 * Cookies (--cookies-from-browser or --cookies) are still recommended to
 * avoid bot-check rate-limits on burst downloads.
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
  /**
   * Skip videos longer than this many seconds, BEFORE downloading
   * (yt-dlp `--match-filter "duration <= N"`). A filtered video pulls no
   * bytes and resolves to `null` (skipped), so a stray 40-hour stream
   * can't blow up the batch. Omit for no cap — long media is segmented by
   * `ChunkedStt`, so length alone is not a blocker.
   */
  readonly maxDurationSec?: number
  /**
   * Read cookies from a local browser (`chrome`, `firefox`, `chrome:Profile 1`)
   * — passed to yt-dlp as `--cookies-from-browser`. Authenticated requests
   * sidestep YouTube's "confirm you're not a bot" rate-limit that public
   * fetches hit after a burst of downloads.
   */
  readonly cookiesFromBrowser?: string
  /** Path to a Netscape cookies.txt — passed to yt-dlp as `--cookies`. */
  readonly cookiesFile?: string
  /**
   * Directory that contains the `ffmpeg` / `ffprobe` binaries (e.g.
   * `/opt/homebrew/bin`). Passed as `--ffmpeg-location` to yt-dlp so the
   * postprocessor can find them even when PATH is not inherited by the
   * subprocess. Omit to rely on yt-dlp's default PATH search.
   */
  readonly ffmpegLocation?: string
}

export class YtDlpWhisperFetcher implements FetcherPort {
  private readonly stt: SttPort
  private readonly download: AudioDownloader
  private readonly extraHosts: ReadonlySet<string> | undefined

  constructor(opts: YtDlpWhisperFetcherOptions) {
    this.stt = opts.stt
    this.download =
      opts.download ??
      defaultYtDlpDownloader(opts.ytDlpBin ?? "yt-dlp", {
        maxDurationSec: opts.maxDurationSec,
        cookiesFromBrowser: opts.cookiesFromBrowser,
        cookiesFile: opts.cookiesFile,
        ffmpegLocation: opts.ffmpegLocation,
      })
    this.extraHosts = opts.extraVideoHosts
      ? new Set(opts.extraVideoHosts)
      : undefined
  }

  async fetch(url: string): Promise<FetchedSource | null> {
    if (!isVideoUrl(url, this.extraHosts)) return null // let a readability fetcher handle it

    let dl: AudioDownload
    try {
      dl = await this.download(url)
    } catch (e) {
      // Per-video download failure (geo-block, private, removed, or a
      // YouTube bot-check) → skip, don't abort the batch. Surface it so a
      // run that silently downloads nothing is diagnosable (e.g. the
      // bot-check that --cookies-from-browser fixes) rather than looking
      // like "0 videos found".
      process.stderr.write(`corpus: download failed for ${url} — skipped (${msg(e)})\n`)
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
    } catch (e) {
      // A transcription failure on ONE video must not abort the whole
      // batch (the STT layer already retries transient blips). Skip it and
      // let the resumable importer retry on the next run — EXCEPT for an
      // auth/config error, which would fail every video, so we surface it
      // loudly rather than silently dropping the entire run.
      if (isAuthError(e)) throw e
      process.stderr.write(
        `corpus: transcription failed for ${url} — skipped (${msg(e)})\n`
      )
      return null
    } finally {
      await dl.cleanup().catch(() => {})
    }
  }
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/** A 401/403 or "api key" error fails every video — abort, don't skip. */
function isAuthError(e: unknown): boolean {
  const m = msg(e).toLowerCase()
  return (
    m.includes(" 401") ||
    m.includes(" 403") ||
    m.includes("unauthorized") ||
    m.includes("forbidden") ||
    m.includes("api key") ||
    m.includes("api_key")
  )
}

// ── Default yt-dlp subprocess downloader ────────────────────────────

interface YtDlpOpts {
  readonly maxDurationSec?: number
  readonly cookiesFromBrowser?: string
  readonly cookiesFile?: string
  readonly ffmpegLocation?: string
}

/** Build the yt-dlp argument list for a given URL and output dir. Exported for unit tests. */
export function buildYtDlpArgs(url: string, dir: string, opts?: YtDlpOpts): string[] {
  // `--match-filter` is evaluated before the media is fetched, so an
  // over-length video pulls zero bytes — it just yields no output file.
  const durationGuard =
    opts?.maxDurationSec && opts.maxDurationSec > 0
      ? ["--match-filter", `duration <= ${Math.floor(opts.maxDurationSec)}`]
      : []
  // Authenticate via local browser cookies (or a cookies.txt) to dodge
  // YouTube's bot-check rate-limit on bursts of public downloads.
  const cookieArgs = opts?.cookiesFromBrowser
    ? ["--cookies-from-browser", opts.cookiesFromBrowser]
    : opts?.cookiesFile
      ? ["--cookies", opts.cookiesFile]
      : []
  // Pass the ffmpeg directory explicitly so the postprocessor finds it even
  // when PATH is not inherited by the yt-dlp subprocess.
  const ffmpegArgs = opts?.ffmpegLocation
    ? ["--ffmpeg-location", opts.ffmpegLocation]
    : []
  // Both android (no-cookie) and web_creator (cookie) fall back to format 18
  // (progressive MP4) which requires no PO token. The default web client uses
  // DASH formats that do require one → HTTP 403.
  // android does not support cookie auth so yt-dlp skips it when cookies are
  // present; web_creator does and its DASH formats are warned-off → fmt 18.
  const client = cookieArgs.length === 0 ? "android" : "web_creator"
  const extractorArgs = ["--extractor-args", `youtube:player_client=${client}`]
  return [
    "-f", "bestaudio/best",           // /best fallback: many videos lack a standalone bestaudio
    "-x", "--audio-format", "mp3", "--audio-quality", "64K",
    "--no-playlist", "--no-progress",
    "--remote-components", "ejs:github", // solves YouTube nsig "n challenge"
    ...extractorArgs,
    ...durationGuard,
    ...cookieArgs,
    ...ffmpegArgs,
    "--write-info-json",
    "-o", join(dir, "track.%(ext)s"),
    url,
  ]
}

function defaultYtDlpDownloader(bin: string, opts?: YtDlpOpts): AudioDownloader {
  return async (url: string): Promise<AudioDownload> => {
    const dir = await mkdtemp(join(tmpdir(), "corpus-ytdlp-"))
    const cleanup = () => rm(dir, { recursive: true, force: true })
    try {
      await execFileAsync(
        bin,
        buildYtDlpArgs(url, dir, opts),
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
