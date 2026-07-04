import { describe, it, expect, vi } from "vitest"
import { writeFile, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  YtDlpCaptionsFetcher,
  buildYtDlpCaptionArgs,
  parseVttToText,
  pickVtt,
  type CaptionDownload,
} from "../ytdlp-captions-fetcher.adapter.js"

const SAMPLE_VTT = `WEBVTT
Kind: captions
Language: fr

00:00:00.030 --> 00:00:02.430 align:start position:0%


00:00:02.440 --> 00:00:04.000 align:start position:0%
bonjour<00:00:02.539><c> à</c><00:00:02.870><c> tous</c>

00:00:04.000 --> 00:00:06.000
bonjour à tous
aujourd'hui on parle d'écriture
`

const ROLLING_VTT = `WEBVTT

00:00:00.000 --> 00:00:01.000
je
00:00:01.000 --> 00:00:02.000
je pense
00:00:02.000 --> 00:00:03.000
je pense donc je suis
`

async function tmpVtt(content: string): Promise<{ path: string; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), "cap-test-"))
  const path = join(dir, "x.fr.vtt")
  await writeFile(path, content)
  return { path, dir }
}
function fakeDl(vttPath: string | null, dir: string, title = "Une interview"): CaptionDownload {
  return {
    vttPath,
    title,
    language: "fr",
    cleanup: vi.fn(async () => {
      if (dir) await rm(dir, { recursive: true, force: true })
    }),
  }
}

describe("parseVttToText", () => {
  it("strips header, timings, and inline tags; collapses consecutive dupes", () => {
    const text = parseVttToText(SAMPLE_VTT)
    expect(text).toBe("bonjour à tous aujourd'hui on parle d'écriture")
    expect(text).not.toMatch(/-->/)
    expect(text).not.toMatch(/WEBVTT|Kind:|Language:/)
    expect(text).not.toMatch(/<\d|<c>/)
  })
  it("collapses rolling-caption growing prefixes to the final line", () => {
    expect(parseVttToText(ROLLING_VTT)).toBe("je pense donc je suis")
  })
})

describe("buildYtDlpCaptionArgs", () => {
  const URL = "https://www.youtube.com/watch?v=test"
  const DIR = "/tmp/fake"
  it("requests auto-subs without downloading the media", () => {
    const args = buildYtDlpCaptionArgs(URL, DIR)
    expect(args).toContain("--skip-download")
    expect(args).toContain("--write-auto-subs")
    expect(args).toContain("--sub-format")
    expect(args).toContain("vtt")
  })
  it("targets the preferred language family", () => {
    const args = buildYtDlpCaptionArgs(URL, DIR, { preferLang: "fr" })
    expect(args).toContain("--sub-langs")
    expect(args).toContain("fr.*")
  })
  it("defaults to a common-language set when no preferLang", () => {
    const args = buildYtDlpCaptionArgs(URL, DIR)
    const i = args.indexOf("--sub-langs")
    expect(args[i + 1]).toMatch(/en\.\*/)
    expect(args[i + 1]).toMatch(/fr\.\*/)
  })
  it("includes --match-filter when maxDurationSec is set", () => {
    const args = buildYtDlpCaptionArgs(URL, DIR, { maxDurationSec: 3600 })
    expect(args).toContain("--match-filter")
    expect(args).toContain("duration <= 3600")
  })
  it("includes --cookies-from-browser when set", () => {
    const args = buildYtDlpCaptionArgs(URL, DIR, { cookiesFromBrowser: "chrome" })
    expect(args).toContain("--cookies-from-browser")
    expect(args).toContain("chrome")
  })
})

describe("pickVtt", () => {
  it("prefers <lang>-orig over <lang> over others", () => {
    expect(pickVtt(["x.fr.vtt", "x.fr-orig.vtt", "x.en.vtt"], "fr")).toBe("x.fr-orig.vtt")
  })
  it("falls back to <lang> when no -orig", () => {
    expect(pickVtt(["x.en.vtt", "x.fr.vtt"], "fr")).toBe("x.fr.vtt")
  })
  it("prefers an original track when no preferLang", () => {
    expect(pickVtt(["x.de-orig.vtt", "x.en.vtt"])).toBe("x.de-orig.vtt")
  })
  it("returns undefined when there is no .vtt", () => {
    expect(pickVtt(["x.info.json", "a.txt"], "fr")).toBeUndefined()
  })
})

describe("YtDlpCaptionsFetcher", () => {
  it("captioned video → video source via captions", async () => {
    const { path, dir } = await tmpVtt(SAMPLE_VTT)
    const dl = fakeDl(path, dir)
    const f = new YtDlpCaptionsFetcher({ minChars: 5, download: async () => dl })
    const out = await f.fetch("https://www.youtube.com/watch?v=abc")
    expect(out?.kind).toBe("video")
    expect(out?.via).toBe("captions")
    expect(out?.title).toBe("Une interview")
    expect(out?.text).toContain("bonjour à tous")
    expect(out?.language).toBe("fr")
    expect(dl.cleanup).toHaveBeenCalled()
  })
  it("no captions → null (falls through to the Whisper tier)", async () => {
    const f = new YtDlpCaptionsFetcher({ download: async () => fakeDl(null, "") })
    expect(await f.fetch("https://youtu.be/abc")).toBeNull()
  })
  it("returns null for non-video URLs (lets readability take it)", async () => {
    const f = new YtDlpCaptionsFetcher({ download: async () => fakeDl(null, "") })
    expect(await f.fetch("https://www.aihr.com/blog/recruiting-metrics/")).toBeNull()
  })
  it("too-thin transcript → null (lets Whisper try)", async () => {
    const { path, dir } = await tmpVtt(SAMPLE_VTT)
    const f = new YtDlpCaptionsFetcher({ minChars: 10000, download: async () => fakeDl(path, dir) })
    expect(await f.fetch("https://youtu.be/abc")).toBeNull()
  })
  it("download failure → null (does not abort the batch)", async () => {
    const f = new YtDlpCaptionsFetcher({
      download: async () => {
        throw new Error("HTTP Error 429")
      },
    })
    expect(await f.fetch("https://youtu.be/abc")).toBeNull()
  })
})
