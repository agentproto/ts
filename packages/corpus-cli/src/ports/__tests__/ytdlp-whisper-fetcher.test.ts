import { describe, it, expect, vi } from "vitest"
import {
  YtDlpWhisperFetcher,
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
