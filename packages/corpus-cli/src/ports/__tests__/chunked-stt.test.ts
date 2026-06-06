import { describe, it, expect, vi, beforeAll, afterAll } from "vitest"
import { mkdtemp, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ChunkedStt, type AudioSplitter } from "../chunked-stt.adapter.js"
import type { SttPort } from "../stt.port.js"

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

const fakeStt = (impl: (path: string) => { text: string; language?: string }): SttPort => ({
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
})
