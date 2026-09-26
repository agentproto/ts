import { describe, it, expect, vi, beforeAll, afterAll } from "vitest"
import { mkdtemp, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ChunkedStt, type AudioSplitter } from "../chunked-stt.adapter.js"
import type { SttPort, Transcript } from "../stt.port.js"

let dir: string
let smallFile: string
let bigFile: string

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "chunked-stt-test-"))
  smallFile = join(dir, "small.mp3")
  bigFile = join(dir, "big.mp3")
  await writeFile(smallFile, Buffer.alloc(10)) // 10 bytes
  await writeFile(bigFile, Buffer.alloc(100)) // 100 bytes
})

afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

const fakeStt = (impl: (path: string) => Transcript): SttPort => ({
  transcribe: vi.fn(async (path: string) => impl(path)),
})

describe("ChunkedStt", () => {
  it("transcribes directly (no split) when the file is within the cap", async () => {
    const base = fakeStt(() => ({ text: "whole transcript", language: "en" }))
    const split = vi.fn<AudioSplitter>()
    const stt = new ChunkedStt({ base, maxBytes: 50, split })

    const out = await stt.transcribe(smallFile)

    expect(out.text).toBe("whole transcript")
    expect(out.language).toBe("en")
    expect(split).not.toHaveBeenCalled()
    expect(base.transcribe).toHaveBeenCalledWith(smallFile)
  })

  it("splits oversized audio, transcribes each part, concatenates in order", async () => {
    const parts = [join(dir, "part000.mp3"), join(dir, "part001.mp3"), join(dir, "part002.mp3")]
    const split: AudioSplitter = vi.fn(async () => parts)
    const byPart: Record<string, { text: string; language?: string }> = {
      [parts[0]!]: { text: "intro", language: "fr" },
      [parts[1]!]: { text: "middle" },
      [parts[2]!]: { text: "end" },
    }
    const base = fakeStt(p => byPart[p]!)
    const stt = new ChunkedStt({ base, maxBytes: 50, segmentSeconds: 600, split })

    const out = await stt.transcribe(bigFile)

    expect(split).toHaveBeenCalledOnce()
    expect(out.text).toBe("intro\n\nmiddle\n\nend")
    expect(out.language).toBe("fr") // first part that reports a language wins
    expect(base.transcribe).toHaveBeenCalledTimes(3)
  })

  it("drops empty-text parts but keeps the rest", async () => {
    const parts = [join(dir, "a.mp3"), join(dir, "b.mp3")]
    const split: AudioSplitter = vi.fn(async () => parts)
    const base = fakeStt(p => (p.endsWith("a.mp3") ? { text: "  " } : { text: "real" }))
    const stt = new ChunkedStt({ base, maxBytes: 50, split })

    const out = await stt.transcribe(bigFile)
    expect(out.text).toBe("real")
  })

  it("falls back to a single base attempt when the splitter yields nothing", async () => {
    const base = fakeStt(() => ({ text: "fallback" }))
    const split: AudioSplitter = vi.fn(async () => [])
    const stt = new ChunkedStt({ base, maxBytes: 50, split })

    const out = await stt.transcribe(bigFile)
    expect(out.text).toBe("fallback")
    expect(base.transcribe).toHaveBeenCalledWith(bigFile)
  })

  it("prefixes speaker labels by segment and shifts offsets by each part's real span", async () => {
    const parts = [join(dir, "u0.mp3"), join(dir, "u1.mp3")]
    const split: AudioSplitter = vi.fn(async () => parts)
    const byPart: Record<string, Transcript> = {
      [parts[0]!]: {
        text: "Speaker A: hello",
        utterances: [{ speaker: "A", text: "hello", start: 0, end: 4 }],
      },
      [parts[1]!]: {
        text: "Speaker B: world",
        utterances: [{ speaker: "B", text: "world", start: 1, end: 3.5 }],
      },
    }
    const base = fakeStt(p => byPart[p]!)
    const stt = new ChunkedStt({ base, maxBytes: 50, segmentSeconds: 600, split })

    const out = await stt.transcribe(bigFile)

    // Labels are segment-local (a base engine re-diarizes each part from
    // scratch), so they're suffixed by segment index; the offset for part 1
    // is part 0's REAL max end (4s), not the nominal segmentSeconds (600).
    expect(out.utterances).toEqual([
      { speaker: "A#0", text: "hello", start: 0, end: 4 },
      { speaker: "B#1", text: "world", start: 5, end: 7.5 },
    ])
    expect(out.speakerLabelsLocalToSegment).toBe(true)
  })

  it("accumulates offsets from each part's own span, not a fixed segmentSeconds (parts of differing length)", async () => {
    const parts = [join(dir, "s0.mp3"), join(dir, "s1.mp3"), join(dir, "s2.mp3")]
    const split: AudioSplitter = vi.fn(async () => parts)
    const byPart: Record<string, Transcript> = {
      [parts[0]!]: { text: "a", utterances: [{ speaker: "A", text: "a", start: 0, end: 3 }] },
      [parts[1]!]: { text: "b", utterances: [{ speaker: "A", text: "b", start: 0, end: 400 }] },
      [parts[2]!]: { text: "c", utterances: [{ speaker: "A", text: "c", start: 0, end: 2 }] },
    }
    const base = fakeStt(p => byPart[p]!)
    const stt = new ChunkedStt({ base, maxBytes: 50, segmentSeconds: 600, split })

    const out = await stt.transcribe(bigFile)

    expect(out.utterances).toEqual([
      { speaker: "A#0", text: "a", start: 0, end: 3 },
      { speaker: "A#1", text: "b", start: 3, end: 403 },
      { speaker: "A#2", text: "c", start: 403, end: 405 },
    ])
  })

  it("propagates the base engine's `engine` field", async () => {
    const base = fakeStt(() => ({ text: "whole transcript", engine: "assemblyai" }))
    const stt = new ChunkedStt({ base, maxBytes: 50 })

    const out = await stt.transcribe(smallFile)
    expect(out.engine).toBe("assemblyai")
  })

  it("omits utterances entirely when no part reports them (non-regression)", async () => {
    const parts = [join(dir, "n0.mp3"), join(dir, "n1.mp3")]
    const split: AudioSplitter = vi.fn(async () => parts)
    const base = fakeStt(() => ({ text: "plain" }))
    const stt = new ChunkedStt({ base, maxBytes: 50, split })

    const out = await stt.transcribe(bigFile)
    expect(out.text).toBe("plain\n\nplain")
    expect(out.utterances).toBeUndefined()
    expect(out.speakerLabelsLocalToSegment).toBeUndefined()
    expect(out.engine).toBeUndefined()
  })
})
