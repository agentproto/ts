import { describe, it, expect, vi } from "vitest"
import { YtDlpWhisperFetcher, type AudioDownload } from "../ytdlp-whisper-fetcher.adapter.js"
import type { SttPort, Transcript } from "../stt.port.js"

const fakeDownload = (title: string): AudioDownload => ({
  audioPath: "/tmp/fake.mp3",
  title,
  cleanup: vi.fn(async () => {}),
})

const fakeStt = (transcript: Transcript): SttPort => ({
  transcribe: vi.fn(async () => transcript),
})

describe("YtDlpWhisperFetcher — diarized transcription", () => {
  it("sets via=diarized-transcription and metadata.speech when the STT returns utterances", async () => {
    const f = new YtDlpWhisperFetcher({
      stt: fakeStt({
        text: "Speaker A: hi\n\nSpeaker B: hello",
        engine: "assemblyai",
        utterances: [
          { speaker: "A", text: "hi", start: 0, end: 1 },
          { speaker: "B", text: "hello", start: 1.2, end: 2 },
        ],
      }),
      download: async () => fakeDownload("A Conversation"),
    })
    const out = await f.fetch("https://www.youtube.com/watch?v=1XboAlFjkOE")

    expect(out?.via).toBe("diarized-transcription")
    expect(out?.metadata).toEqual({
      speech: { regime: "spoken", diarized: true, engine: "assemblyai", speakers: 2 },
    })
  })

  it("falls back to engine: 'unknown' when the STT doesn't report one", async () => {
    const f = new YtDlpWhisperFetcher({
      stt: fakeStt({
        text: "Speaker A: hi\n\nSpeaker B: hello",
        utterances: [
          { speaker: "A", text: "hi" },
          { speaker: "B", text: "hello" },
        ],
      }),
      download: async () => fakeDownload("A Conversation"),
    })
    const out = await f.fetch("https://youtu.be/abc")

    expect((out?.metadata as { speech: { engine: string } } | undefined)?.speech.engine).toBe("unknown")
  })

  it("counts distinct pre-prefixed labels and flags segmented when speakerLabelsLocalToSegment is set", async () => {
    const f = new YtDlpWhisperFetcher({
      stt: fakeStt({
        text: "chunked transcript",
        engine: "assemblyai",
        speakerLabelsLocalToSegment: true,
        utterances: [
          { speaker: "A#0", text: "hi" },
          { speaker: "B#0", text: "hello" },
          { speaker: "A#1", text: "hi again" },
        ],
      }),
      download: async () => fakeDownload("A Long Talk"),
    })
    const out = await f.fetch("https://youtu.be/abc")

    expect(out?.metadata).toEqual({
      speech: { regime: "spoken", diarized: true, engine: "assemblyai", speakers: 3, segmented: true },
    })
  })

  it("counts distinct speakers, not utterance count", async () => {
    const f = new YtDlpWhisperFetcher({
      stt: fakeStt({
        text: "Speaker A: hi\n\nSpeaker A: again\n\nSpeaker B: hello",
        utterances: [
          { speaker: "A", text: "hi" },
          { speaker: "A", text: "again" },
          { speaker: "B", text: "hello" },
        ],
      }),
      download: async () => fakeDownload("A Conversation"),
    })
    const out = await f.fetch("https://youtu.be/abc")

    expect((out?.metadata as { speech: { speakers: number } } | undefined)?.speech.speakers).toBe(2)
  })

  it("leaves via=transcription and no metadata when the STT returns no utterances (non-regression)", async () => {
    const f = new YtDlpWhisperFetcher({
      stt: fakeStt({ text: "a flat transcript, no speakers" }),
      download: async () => fakeDownload("Solo Video"),
    })
    const out = await f.fetch("https://youtu.be/abc")

    expect(out?.via).toBe("transcription")
    expect(out?.metadata).toBeUndefined()
  })

  it("leaves via=transcription when utterances is an empty array", async () => {
    const f = new YtDlpWhisperFetcher({
      stt: fakeStt({ text: "flat", utterances: [] }),
      download: async () => fakeDownload("Solo Video"),
    })
    const out = await f.fetch("https://youtu.be/abc")

    expect(out?.via).toBe("transcription")
    expect(out?.metadata).toBeUndefined()
  })
})
