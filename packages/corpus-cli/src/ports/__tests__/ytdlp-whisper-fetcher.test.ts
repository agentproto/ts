import { describe, it, expect, vi } from "vitest"
import {
  YtDlpWhisperFetcher,
  buildYtDlpArgs,
  type AudioDownload,
} from "../ytdlp-whisper-fetcher.adapter.js"
import { CompositeFetcher } from "../composite-fetcher.js"
import type { SttPort } from "../stt.port.js"
import type { FetcherPort, FetchedSource } from "@agentproto/corpus"

const fakeDownload = (title: string, language?: string): AudioDownload => ({
  audioPath: "/tmp/fake.mp3",
  title,
  ...(language ? { language } : {}),
  cleanup: vi.fn(async () => {}),
})

const fakeStt = (text: string, language?: string): SttPort => ({
  transcribe: vi.fn(async () => ({ text, ...(language ? { language } : {}) })),
})

describe("YtDlpWhisperFetcher", () => {
  it("downloads + transcribes a YouTube URL → video source via transcription", async () => {
    const dl = fakeDownload("How To Read A Job Description")
    const f = new YtDlpWhisperFetcher({
      stt: fakeStt("the transcript text", "en"),
      download: async () => dl,
    })
    const out = await f.fetch("https://www.youtube.com/watch?v=1XboAlFjkOE")
    expect(out?.kind).toBe("video")
    expect(out?.via).toBe("transcription")
    expect(out?.title).toBe("How To Read A Job Description")
    expect(out?.text).toBe("the transcript text")
    expect(out?.language).toBe("en")
    expect(dl.cleanup).toHaveBeenCalled() // temp dir always cleaned
  })

  it("returns null for non-video URLs (lets a readability fetcher take it)", async () => {
    const f = new YtDlpWhisperFetcher({
      stt: fakeStt("x"),
      download: async () => fakeDownload("nope"),
    })
    expect(await f.fetch("https://www.aihr.com/blog/recruiting-metrics/")).toBeNull()
  })

  it("skips (null) when the download fails — does not abort the batch", async () => {
    const f = new YtDlpWhisperFetcher({
      stt: fakeStt("x"),
      download: async () => {
        throw new Error("video unavailable")
      },
    })
    expect(await f.fetch("https://youtu.be/abc")).toBeNull()
  })

  it("returns null on empty transcript", async () => {
    const f = new YtDlpWhisperFetcher({
      stt: fakeStt("   "),
      download: async () => fakeDownload("t"),
    })
    expect(await f.fetch("https://youtu.be/abc")).toBeNull()
  })
})

describe("buildYtDlpArgs", () => {
  const URL = "https://www.youtube.com/watch?v=test"
  const DIR = "/tmp/fake"

  it("uses bestaudio/best format fallback", () => {
    const args = buildYtDlpArgs(URL, DIR)
    expect(args).toContain("bestaudio/best")
    expect(args).not.toContain("bestaudio")  // bare bestaudio must not appear as its own arg
  })

  it("includes --remote-components ejs:github for nsig solver", () => {
    const args = buildYtDlpArgs(URL, DIR)
    expect(args).toContain("--remote-components")
    expect(args).toContain("ejs:github")
  })

  it("uses android client when no cookies (avoids PO-token for unauthenticated)", () => {
    const args = buildYtDlpArgs(URL, DIR)
    expect(args).toContain("--extractor-args")
    expect(args).toContain("youtube:player_client=android")
  })

  it("uses web_creator client when cookies-from-browser set (android skips authed requests)", () => {
    const args = buildYtDlpArgs(URL, DIR, { cookiesFromBrowser: "chrome" })
    expect(args).toContain("--extractor-args")
    expect(args).toContain("youtube:player_client=web_creator")
    expect(args).not.toContain("youtube:player_client=android")
  })

  it("uses web_creator client when cookies-file set", () => {
    const args = buildYtDlpArgs(URL, DIR, { cookiesFile: "/path/cookies.txt" })
    expect(args).toContain("youtube:player_client=web_creator")
    expect(args).not.toContain("youtube:player_client=android")
  })

  it("appends --ffmpeg-location when ffmpegLocation is set", () => {
    const args = buildYtDlpArgs(URL, DIR, { ffmpegLocation: "/opt/homebrew/bin" })
    expect(args).toContain("--ffmpeg-location")
    expect(args).toContain("/opt/homebrew/bin")
  })

  it("omits --ffmpeg-location when ffmpegLocation is not set", () => {
    const args = buildYtDlpArgs(URL, DIR)
    expect(args).not.toContain("--ffmpeg-location")
  })

  it("includes --match-filter when maxDurationSec is set", () => {
    const args = buildYtDlpArgs(URL, DIR, { maxDurationSec: 3600 })
    expect(args).toContain("--match-filter")
    expect(args).toContain("duration <= 3600")
  })

  it("includes --cookies-from-browser when set", () => {
    const args = buildYtDlpArgs(URL, DIR, { cookiesFromBrowser: "chrome" })
    expect(args).toContain("--cookies-from-browser")
    expect(args).toContain("chrome")
    // covered by the android-exclusion tests above
  })
})

describe("CompositeFetcher", () => {
  const stub = (result: FetchedSource | null): FetcherPort => ({
    fetch: vi.fn(async () => result),
  })

  it("returns the first non-null result and stops", async () => {
    const a = stub(null)
    const b = stub({ title: "B", text: "b", kind: "article" })
    const c = stub({ title: "C", text: "c", kind: "article" })
    const out = await new CompositeFetcher([a, b, c]).fetch("https://x.com")
    expect(out?.title).toBe("B")
    expect(a.fetch).toHaveBeenCalled()
    expect(b.fetch).toHaveBeenCalled()
    expect(c.fetch).not.toHaveBeenCalled() // short-circuits
  })

  it("returns null when all children pass", async () => {
    const out = await new CompositeFetcher([stub(null), stub(null)]).fetch("https://x.com")
    expect(out).toBeNull()
  })
})
