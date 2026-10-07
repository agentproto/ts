import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { describe, it, expect, vi, afterEach } from "vitest"
import { LocalFileFetcher } from "../local-file-fetcher.adapter.js"
import type { SttPort, Transcript } from "../stt.port.js"

const fakeStt = (transcript: Transcript): SttPort => ({
  transcribe: vi.fn(async () => transcript),
})

describe("LocalFileFetcher", () => {
  let dir: string | undefined

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true })
    dir = undefined
  })

  async function makeFile(name: string, contents = "fake audio bytes"): Promise<string> {
    dir = await mkdtemp(join(tmpdir(), "corpus-local-file-"))
    const path = join(dir, name)
    await writeFile(path, contents)
    return path
  }

  it("transcribes a bare local path → video source via transcription", async () => {
    const path = await makeFile("track.mp3")
    const f = new LocalFileFetcher({ stt: fakeStt({ text: "the transcript text", language: "en" }) })

    const out = await f.fetch(path)

    expect(out?.kind).toBe("video")
    expect(out?.via).toBe("transcription")
    expect(out?.title).toBe("track")
    expect(out?.text).toBe("the transcript text")
    expect(out?.language).toBe("en")
  })

  it("transcribes a file:// URI the same way", async () => {
    const path = await makeFile("recording.mp3")
    const f = new LocalFileFetcher({ stt: fakeStt({ text: "hello" }) })

    const out = await f.fetch(pathToFileURL(path).toString())

    expect(out?.text).toBe("hello")
  })

  it("sets via=diarized-transcription and metadata.speech when the STT diarizes", async () => {
    const path = await makeFile("panel.mp3")
    const f = new LocalFileFetcher({
      stt: fakeStt({
        text: "Speaker A: hi\n\nSpeaker B: hello",
        engine: "assemblyai",
        utterances: [
          { speaker: "A", text: "hi" },
          { speaker: "B", text: "hello" },
        ],
      }),
    })

    const out = await f.fetch(path)

    expect(out?.via).toBe("diarized-transcription")
    expect(out?.metadata).toEqual({
      speech: { regime: "spoken", diarized: true, engine: "assemblyai", speakers: 2 },
    })
  })

  it("returns null for an http(s) URL — lets the yt-dlp tiers handle it", async () => {
    const f = new LocalFileFetcher({ stt: fakeStt({ text: "x" }) })
    expect(await f.fetch("https://www.youtube.com/watch?v=1XboAlFjkOE")).toBeNull()
  })

  it("returns null for a path that doesn't exist on disk", async () => {
    const f = new LocalFileFetcher({ stt: fakeStt({ text: "x" }) })
    expect(await f.fetch("/no/such/file-ever-9f3c2.mp3")).toBeNull()
  })

  it("returns null for a directory (not a regular file)", async () => {
    dir = await mkdtemp(join(tmpdir(), "corpus-local-file-"))
    const sub = join(dir, "subdir")
    await mkdir(sub)
    const f = new LocalFileFetcher({ stt: fakeStt({ text: "x" }) })
    expect(await f.fetch(sub)).toBeNull()
  })

  it("returns null on an empty transcript", async () => {
    const path = await makeFile("silent.mp3")
    const f = new LocalFileFetcher({ stt: fakeStt({ text: "   " }) })
    expect(await f.fetch(path)).toBeNull()
  })

  it("skips (null) when transcription fails for a non-auth reason", async () => {
    const path = await makeFile("broken.mp3")
    const f = new LocalFileFetcher({
      stt: { transcribe: vi.fn(async () => { throw new Error("network reset") }) },
    })
    expect(await f.fetch(path)).toBeNull()
  })

  it("rethrows an auth error instead of skipping", async () => {
    const path = await makeFile("broken.mp3")
    const f = new LocalFileFetcher({
      stt: { transcribe: vi.fn(async () => { throw new Error("401 unauthorized") }) },
    })
    await expect(f.fetch(path)).rejects.toThrow(/401/)
  })
})
