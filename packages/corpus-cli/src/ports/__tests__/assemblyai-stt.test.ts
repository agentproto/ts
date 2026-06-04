import { describe, it, expect, vi, afterEach } from "vitest"
import { writeFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { AssemblyAiStt } from "../assemblyai-stt.adapter.js"

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

/** Scripted AssemblyAI sequence: upload → create(processing) → poll(completed). */
function mockAaiSequence(transcript: Record<string, unknown>) {
  const calls: string[] = []
  globalThis.fetch = vi.fn<typeof fetch>(async (url, init) => {
    const u = String(url)
    calls.push(`${init?.method ?? "GET"} ${u.replace(/^https:\/\/api\.assemblyai\.com\/v2/, "")}`)
    if (u.endsWith("/upload")) return new Response(JSON.stringify({ upload_url: "https://cdn/audio" }))
    if (u.endsWith("/transcript")) return new Response(JSON.stringify({ id: "t1", status: "processing" }))
    if (u.includes("/transcript/t1")) return new Response(JSON.stringify(transcript))
    throw new Error(`unexpected fetch ${u}`)
  })
  return calls
}

describe("AssemblyAiStt", () => {
  it("uploads, requests speaker_labels, polls, and formats diarized text", async () => {
    const calls = mockAaiSequence({
      id: "t1",
      status: "completed",
      language_code: "en",
      utterances: [
        { speaker: "A", text: "How do you read a job description?" },
        { speaker: "B", text: "Start with the must-haves." },
      ],
    })
    const tmp = join(tmpdir(), "aai-test.mp3")
    await writeFile(tmp, Buffer.from("fake-audio"))
    try {
      const stt = new AssemblyAiStt({ apiKey: "k", pollIntervalMs: 0, sleep: async () => {} })
      const out = await stt.transcribe(tmp)
      expect(out.language).toBe("en")
      expect(out.text).toBe(
        "Speaker A: How do you read a job description?\n\nSpeaker B: Start with the must-haves."
      )
      // requested diarization on create
      expect(calls).toContain("POST /upload")
      expect(calls).toContain("POST /transcript")
      expect(calls.some(c => c.includes("/transcript/t1"))).toBe(true)
    } finally {
      await rm(tmp, { force: true })
    }
  })

  it("falls back to flat text when no utterances", async () => {
    mockAaiSequence({ id: "t1", status: "completed", text: "flat transcript", utterances: null })
    const tmp = join(tmpdir(), "aai-test2.mp3")
    await writeFile(tmp, Buffer.from("x"))
    try {
      const out = await new AssemblyAiStt({ apiKey: "k", sleep: async () => {} }).transcribe(tmp)
      expect(out.text).toBe("flat transcript")
    } finally {
      await rm(tmp, { force: true })
    }
  })

  it("throws on transcript error status", async () => {
    mockAaiSequence({ id: "t1", status: "error", error: "audio too short" })
    const tmp = join(tmpdir(), "aai-test3.mp3")
    await writeFile(tmp, Buffer.from("x"))
    try {
      await expect(
        new AssemblyAiStt({ apiKey: "k", sleep: async () => {} }).transcribe(tmp)
      ).rejects.toThrow(/audio too short/)
    } finally {
      await rm(tmp, { force: true })
    }
  })
})
