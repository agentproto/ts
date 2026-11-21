// @ts-nocheck
// Ported from agentik-studio projects/simone/apps/voice/test/calls/pipeline-trim-logs.test.ts
// The expect blocks are unchanged from the studio original; only imports (and,
// where noted in the PR, injected provider labels) differ. Type checking is off
// for this file because the studio does not type-check its test files.
/**
 * Silence trimming of the STT payload and the observability log lines.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createCallPipeline } from "../../cascade/pipeline.js"
import { feed, makeOutbound, SR, ttsChunk } from "./pipeline-test-kit.js"

function setup() {
  const out = makeOutbound()
  const transcribe = vi.fn(async () => "texte secret du client")
  const onTurn = vi.fn(
    async ({ onChunk }: { onChunk: (b: Buffer) => void | Promise<void> }) => {
      await onChunk(ttsChunk(1500))
      return "réponse secrète"
    }
  )
  const pipeline = createCallPipeline({
    transport: out.transport,
    playback: out.playback,
    sampleRate: SR,
    transcribe,
    onTurn: onTurn as never,
    bargeIn: { enabled: false },
    logPrefix: "[test]",
  } as never)
  return { out, pipeline, transcribe, onTurn }
}

const wavMs = (call: unknown[]) =>
  ((call[0] as { pcm16: Int16Array }).pcm16.length / SR) * 1000

describe("silence trimming", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.spyOn(console, "warn").mockImplementation(() => {})
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it("sends only a 300 ms pre-roll of the silence that preceded the speech", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {})
    const ctx = setup()
    await feed(ctx.pipeline, "quiet", 6000)
    await feed(ctx.pipeline, "loud", 500)
    await feed(ctx.pipeline, "quiet", 800)
    const ms = wavMs(ctx.transcribe.mock.calls[0]!)
    // 300 pre-roll + 500 speech + 700 trailing silence (the VAD end marker).
    expect(ms).toBeGreaterThanOrEqual(1480)
    expect(ms).toBeLessThanOrEqual(1540)
  })

  it("keeps the start of the first word (pre-roll precedes the first loud frame)", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {})
    const ctx = setup()
    await feed(ctx.pipeline, "quiet", 1000)
    await feed(ctx.pipeline, "loud", 200)
    await feed(ctx.pipeline, "quiet", 800)
    const pcm = (ctx.transcribe.mock.calls[0]![0] as { pcm16: Int16Array })
      .pcm16
    const firstLoud = pcm.findIndex(v => v !== 0)
    expect((firstLoud / SR) * 1000).toBeGreaterThanOrEqual(280)
  })
})

describe("log lines", () => {
  let lines: string[]
  beforeEach(() => {
    vi.useFakeTimers()
    vi.spyOn(console, "warn").mockImplementation(() => {})
    lines = []
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
      lines.push(a.map(String).join(" "))
    })
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it("emits one key=value line per stage, with no transcript text", async () => {
    const ctx = setup()
    await feed(ctx.pipeline, "loud", 500)
    await feed(ctx.pipeline, "quiet", 800)

    const find = (needle: string) => lines.find(l => l.includes(needle))
    expect(find("vad utterance")).toMatch(
      /utt=1 .*speech_ms=\d+ .*trailing_silence_ms=7\d\d/
    )
    expect(find("vad utterance")).toMatch(/start_at=\d+ end_at=\d+/)
    expect(find("stt done")).toMatch(/utt=1 stt_ms=\d+ wav_ms=\d+/)
    expect(find("brain dispatch")).toMatch(
      /utt=1 at=\d+ since_speech_end_ms=\d+/
    )
    expect(find("outbound first audio")).toMatch(/utt=1 queue_ms=0/)
    for (const l of lines) {
      expect(l).not.toContain("secret")
    }
  })
})
