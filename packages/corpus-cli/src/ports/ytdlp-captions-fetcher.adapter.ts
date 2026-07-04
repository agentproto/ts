/**
 * YtDlpCaptionsFetcher — a FetcherPort for video URLs that pulls the
 * video's SUBTITLES (uploaded or auto-generated) with yt-dlp and returns
 * them as text, with NO speech-to-text and NO API key. This is the
 * architecture's tier-1 "captions" path ({@link FetcherPort} doc): the
 * cheap, fast, free way to turn a video into a transcript.
 *
 *   video URL → yt-dlp --write-auto-subs --skip-download (VTT) → text
 *
 * Sits AHEAD of {@link YtDlpWhisperFetcher} in the import-web chain: when a
 * video has captions this resolves it for free; when it does not, this
 * returns `null` and the Whisper tier (if an STT key is configured) takes
 * over. The sibling Whisper adapter was written when YouTube's caption
 * endpoints were pot/SABR-gated; modern yt-dlp (`--write-auto-subs` with
 * `--sub-langs`) retrieves auto-captions reliably again, so captions-first
 * is both cheaper and key-free — Whisper becomes the caption-less fallback.
 *
 * Cookies (--cookies-from-browser / --cookies) are optional but dodge the
 * HTTP 429 bot-check on bursts; the outer ThrottleFetcher already spaces
 * fetches, and `--sleep-requests` spaces the per-language sub requests.
 *
 * The yt-dlp invocation is injected as `download` so the adapter is unit-
 * testable with a fake downloader — no binary, no network. `parseVttToText`
 * and `buildYtDlpCaptionArgs` are exported pure for direct testing.
 */

import { execFile } from "node:child_process"
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { z } from "zod"
import type { FetcherPort, FetchedSource } from "@agentproto/corpus"
import { isVideoUrl } from "./video-hosts.js"

const execFileAsync = promisify(execFile)

/** yt-dlp's `.info.json` — only the fields we use. */
const YTDLP_INFO = z
  .object({ title: z.string().optional(), language: z.string().optional() })
  .loose()

export interface CaptionDownload {
  /** Local path to the chosen .vtt subtitle file, or null when the video has none. */
  readonly vttPath: string | null
  readonly title: string
  readonly language?: string
  /** Remove the temp working dir. Always called by the fetcher. */
  cleanup(): Promise<void>
}

/** Pull a URL's subtitles to a local .vtt. Injectable for tests. */
export type CaptionDownloader = (url: string) => Promise<CaptionDownload>

export interface YtDlpCaptionsFetcherOptions {
  /** Defaults to a yt-dlp subprocess downloader. */
  readonly download?: CaptionDownloader
  /** Path to the yt-dlp binary (default: "yt-dlp" on PATH). */
  readonly ytDlpBin?: string
  /** Treat these hostnames as video (in addition to the YouTube/Vimeo set). */
  readonly extraVideoHosts?: readonly string[]
  /**
   * Preferred caption language (BCP-47 prefix, e.g. "fr"). Drives the
   * yt-dlp `--sub-langs` selector and the best-file picker so a French
   * subject's auto-captions are taken in French. Omit to accept a broad
   * common-language set and prefer the original-language track.
   */
  readonly preferLang?: string
  /** Explicit yt-dlp `--sub-langs` selector — overrides the preferLang default. */
  readonly subLangs?: string
  /** Reject a transcript shorter than this many characters (junk guard). Default 400. */
  readonly minChars?: number
  /** Skip videos longer than this (yt-dlp `--match-filter "duration <= N"`). */
  readonly maxDurationSec?: number
  /** `--cookies-from-browser` value (e.g. "chrome") to dodge the 429 bot-check. */
  readonly cookiesFromBrowser?: string
  /** Path to a Netscape cookies.txt — passed to yt-dlp as `--cookies`. */
  readonly cookiesFile?: string
}

export class YtDlpCaptionsFetcher implements FetcherPort {
  private readonly download: CaptionDownloader
  private readonly extraHosts: ReadonlySet<string> | undefined
  private readonly minChars: number

  constructor(opts: YtDlpCaptionsFetcherOptions = {}) {
    this.minChars = opts.minChars ?? 400
    this.download =
      opts.download ??
      defaultYtDlpCaptionDownloader(opts.ytDlpBin ?? "yt-dlp", {
        ...(opts.subLangs ? { subLangs: opts.subLangs } : {}),
        ...(opts.preferLang ? { preferLang: opts.preferLang } : {}),
        ...(opts.maxDurationSec ? { maxDurationSec: opts.maxDurationSec } : {}),
        ...(opts.cookiesFromBrowser
          ? { cookiesFromBrowser: opts.cookiesFromBrowser }
          : {}),
        ...(opts.cookiesFile ? { cookiesFile: opts.cookiesFile } : {}),
      })
    this.extraHosts = opts.extraVideoHosts
      ? new Set(opts.extraVideoHosts)
      : undefined
  }

  async fetch(url: string): Promise<FetchedSource | null> {
    if (!isVideoUrl(url, this.extraHosts)) return null // not a video — pass on

    let dl: CaptionDownload
    try {
      dl = await this.download(url)
    } catch (e) {
      // No captions / per-video fetch failure → let the Whisper tier try.
      process.stderr.write(
        `corpus: caption fetch failed for ${url} — falling back (${msg(e)})\n`
      )
      return null
    }
    try {
      if (!dl.vttPath) return null // no captions → fall through to Whisper
      const text = parseVttToText(await readFile(dl.vttPath, "utf-8"))
      if (text.length < this.minChars) return null // too thin → let Whisper try
      return {
        title: dl.title || url,
        text,
        kind: "video",
        ...(dl.language ? { language: dl.language } : {}),
        via: "captions",
      }
    } catch {
      return null
    } finally {
      await dl.cleanup().catch(() => {})
    }
  }
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/**
 * Reduce a WebVTT cue track to clean prose: drop the header, cue-timing,
 * and `<...>` inline tags, then collapse the rolling-caption duplication
 * auto-captions emit (each line appears as a growing prefix then in full).
 * Pure — exported for direct unit testing.
 */
export function parseVttToText(vtt: string): string {
  const out: string[] = []
  for (const raw of vtt.split(/\r?\n/)) {
    if (/^WEBVTT/.test(raw)) continue
    if (/^(Kind|Language|NOTE|STYLE):/i.test(raw)) continue
    if (raw.includes("-->")) continue
    const line = raw
      .replace(/<[^>]+>/g, "")
      .replace(/&nbsp;/gi, " ")
      .replace(/ /g, " ")
      .trim()
    if (!line) continue
    if (out.length && out[out.length - 1] === line) continue
    out.push(line)
  }
  const cleaned: string[] = []
  for (let i = 0; i < out.length; i++) {
    const next = out[i + 1]
    if (next && next.startsWith(out[i]!)) continue // growing rolling-caption prefix
    cleaned.push(out[i]!)
  }
  return cleaned
    .join(" ")
    .replace(/\s+/g, " ")
    .trim()
}

// ── Default yt-dlp subprocess downloader ────────────────────────────

interface CaptionOpts {
  readonly subLangs?: string
  readonly preferLang?: string
  readonly maxDurationSec?: number
  readonly cookiesFromBrowser?: string
  readonly cookiesFile?: string
}

/** Build the yt-dlp argument list for caption extraction. Exported for unit tests. */
export function buildYtDlpCaptionArgs(
  url: string,
  dir: string,
  opts?: CaptionOpts
): string[] {
  const subLangs =
    opts?.subLangs ??
    (opts?.preferLang
      ? `${opts.preferLang}.*`
      : "en.*,fr.*,es.*,de.*,it.*,pt.*,nl.*")
  const durationGuard =
    opts?.maxDurationSec && opts.maxDurationSec > 0
      ? ["--match-filter", `duration <= ${Math.floor(opts.maxDurationSec)}`]
      : []
  const cookieArgs = opts?.cookiesFromBrowser
    ? ["--cookies-from-browser", opts.cookiesFromBrowser]
    : opts?.cookiesFile
      ? ["--cookies", opts.cookiesFile]
      : []
  return [
    "--skip-download",
    "--write-auto-subs",
    "--write-subs",
    "--sub-langs", subLangs,
    "--sub-format", "vtt",
    "--no-playlist", "--no-progress",
    "--sleep-requests", "1",
    ...durationGuard,
    ...cookieArgs,
    "--write-info-json",
    "-o", join(dir, "%(id)s.%(ext)s"),
    url,
  ]
}

/** Pick the best .vtt among yt-dlp's outputs, preferring the requested language and the original track. */
export function pickVtt(
  files: readonly string[],
  preferLang?: string
): string | undefined {
  const vtts = files.filter(f => f.endsWith(".vtt"))
  if (vtts.length === 0) return undefined
  const bySuffix = (suffix: string) =>
    vtts.find(f => f.toLowerCase().endsWith(suffix.toLowerCase()))
  if (preferLang) {
    return (
      bySuffix(`.${preferLang}-orig.vtt`) ??
      bySuffix(`.${preferLang}.vtt`) ??
      vtts.find(f => new RegExp(`\\.${preferLang}[.-]`, "i").test(f)) ??
      vtts.find(f => /-orig\.vtt$/i.test(f)) ??
      vtts[0]
    )
  }
  return vtts.find(f => /-orig\.vtt$/i.test(f)) ?? vtts[0]
}

function defaultYtDlpCaptionDownloader(
  bin: string,
  opts?: CaptionOpts
): CaptionDownloader {
  return async (url: string): Promise<CaptionDownload> => {
    const dir = await mkdtemp(join(tmpdir(), "corpus-captions-"))
    const cleanup = () => rm(dir, { recursive: true, force: true })
    try {
      // yt-dlp exits non-zero if SOME requested sub-lang 429s even when
      // another already wrote — tolerate it and inspect the dir instead.
      await execFileAsync(bin, buildYtDlpCaptionArgs(url, dir, opts), {
        maxBuffer: 16 * 1024 * 1024,
      }).catch(() => {})
      const files = await readdir(dir)
      const vtt = pickVtt(files, opts?.preferLang)

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
          // info json optional
        }
      }
      return {
        vttPath: vtt ? join(dir, vtt) : null,
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
