// @ts-nocheck
// Type checking is off for this file: it is kept close to a verbatim test suite.
/**
 * Barge-in: the caller talks over the assistant. Uses a fake clock so the VAD's
 * wall-clock timing is exact, and a counter-based outbound queue so "audio
 * still waiting to be played" is observable.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createCallPipeline } from "../../cascade/pipeline.js"
import {
  abortError,
  feed,
  hangUntilAborted,
  makeOutbound,
  SR,
  ttsChunk,
} from "./pipeline-test-kit.js"

const MIN_SPEECH_MS = 300
const GUARD_MS = 500

type Out = ReturnType<typeof makeOutbound>

function setup(
  over: {
    bargeIn?: { enabled?: boolean; minSpeechMs?: number; guardMs?: number }
    onTurn?: (input: {
      text: string
      onChunk: (pcm: Buffer) => void | Promise<void>
      signal?: AbortSignal
    }) => Promise<string | void>
  } = {}
) {
  const out: Out = makeOutbound()
  const transcribe = vi.fn(async () => "bonjour")
  const signals: AbortSignal[] = []
  const bargeSignals: AbortSignal[] = []
  const audio = { startedAt: 0 }
  const onTurn = vi.fn(
    over.onTurn ??
      (async ({
        onChunk,
        signal,
        bargeInSignal,
      }: {
        onChunk: (pcm: Buffer) => void | Promise<void>
        signal?: AbortSignal
        bargeInSignal?: AbortSignal
      }) => {
        if (signal) signals.push(signal)
        if (bargeInSignal) bargeSignals.push(bargeInSignal)
        audio.startedAt = Date.now()
        await onChunk(ttsChunk(4000))
        await hangUntilAborted(signal)
      })
  )
  const transcripts: Array<{ text: string; role: string }> = []
  const pipeline = createCallPipeline({
    transport: out.transport,
    playback: out.playback,
    outboundQueueMaxMs: 0,
    sampleRate: SR,
    transcribe,
    onTurn: onTurn as never,
    onTranscript: (text, role) => transcripts.push({ text, role }),
    bargeIn: {
      enabled: true,
      minSpeechMs: MIN_SPEECH_MS,
      guardMs: GUARD_MS,
      ...over.bargeIn,
    },
    logPrefix: "[test]",
  })
  return {
    out,
    pipeline,
    transcribe,
    onTurn,
    signals,
    bargeSignals,
    transcripts,
    audio,
  }
}

/** First utterance + silence so the assistant starts speaking (4 s queued). */
async function startSpeaking(ctx: ReturnType<typeof setup>) {
  await feed(ctx.pipeline, "loud", 400)
  await feed(ctx.pipeline, "quiet", 800)
  expect(ctx.onTurn).toHaveBeenCalledTimes(1)
  expect(ctx.out.queued()).toBeGreaterThan(3000)
}

describe("barge-in", () => {
  let errors: ReturnType<typeof vi.spyOn>
  let logs: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.useFakeTimers()
    errors = vi.spyOn(console, "error").mockImplementation(() => {})
    vi.spyOn(console, "warn").mockImplementation(() => {})
    logs = vi.spyOn(console, "log").mockImplementation(() => {})
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it("fires only after minSpeechMs of continuous speech, then aborts, purges and cancels", async () => {
    const ctx = setup()
    await startSpeaking(ctx)
    await feed(ctx.pipeline, "quiet", GUARD_MS + 100)

    await feed(ctx.pipeline, "loud", MIN_SPEECH_MS - 40)
    expect(ctx.signals[0]!.aborted).toBe(false)
    expect(ctx.out.controls).not.toContain("interrupt")

    await feed(ctx.pipeline, "loud", 60)
    expect(ctx.signals[0]!.aborted).toBe(true)
    expect(ctx.out.controls.filter(c => c === "interrupt")).toHaveLength(1)
    expect(ctx.out.purged[0]).toBeGreaterThan(2000)
    expect(ctx.out.queued()).toBe(0)
  })

  it("aborts a dedicated barge-in signal before the turn signal (played-text snapshot)", async () => {
    const ctx = setup()
    await startSpeaking(ctx)
    await feed(ctx.pipeline, "quiet", GUARD_MS + 100)
    await feed(ctx.pipeline, "loud", MIN_SPEECH_MS + 60)
    // Both fire on the same barge-in; the dedicated one is what the turn
    // reads to snapshot spoken/unspoken before the outbound purge.
    expect(ctx.bargeSignals[0]!.aborted).toBe(true)
    expect(ctx.signals[0]!.aborted).toBe(true)
  })

  it("does not fire the barge-in signal on a noise burst shorter than minSpeechMs", async () => {
    const ctx = setup()
    await startSpeaking(ctx)
    await feed(ctx.pipeline, "quiet", GUARD_MS + 100)
    await feed(ctx.pipeline, "loud", 200)
    expect(ctx.bargeSignals[0]!.aborted).toBe(false)
  })

  it("ignores a noise burst shorter than minSpeechMs", async () => {
    const ctx = setup()
    await startSpeaking(ctx)
    await feed(ctx.pipeline, "quiet", GUARD_MS + 100)
    await feed(ctx.pipeline, "loud", 200)
    await feed(ctx.pipeline, "quiet", 300)
    await feed(ctx.pipeline, "loud", 200)
    await feed(ctx.pipeline, "quiet", 300)
    expect(ctx.signals[0]!.aborted).toBe(false)
    expect(ctx.out.controls).not.toContain("interrupt")
  })

  it("bridges a short dip inside one word (stop consonant) without resetting the run", async () => {
    const ctx = setup()
    await startSpeaking(ctx)
    await feed(ctx.pipeline, "quiet", GUARD_MS + 100)
    await feed(ctx.pipeline, "loud", 160)
    await feed(ctx.pipeline, "quiet", 60)
    await feed(ctx.pipeline, "loud", 160)
    expect(ctx.signals[0]!.aborted).toBe(true)
  })

  it("does not count speech inside the echo guard that follows the start of playback", async () => {
    const ctx = setup()
    await startSpeaking(ctx)
    const sinceAudio = () => Date.now() - ctx.audio.startedAt
    // Loud from now on: the run may only start once the guard has elapsed, so
    // it needs GUARD_MS + MIN_SPEECH_MS after the first audio to fire.
    const target = GUARD_MS + MIN_SPEECH_MS
    await feed(ctx.pipeline, "loud", target - sinceAudio() - 40)
    expect(ctx.signals[0]!.aborted).toBe(false)
    await feed(ctx.pipeline, "loud", 80)
    expect(ctx.signals[0]!.aborted).toBe(true)
  })

  it("does nothing while the turn has not produced any audio yet", async () => {
    const ctx = setup({
      onTurn: async ({ signal }) => {
        await hangUntilAborted(signal)
      },
    })
    await feed(ctx.pipeline, "loud", 400)
    await feed(ctx.pipeline, "quiet", 800)
    expect(ctx.onTurn).toHaveBeenCalledTimes(1)
    await feed(ctx.pipeline, "quiet", GUARD_MS + 100)
    await feed(ctx.pipeline, "loud", 900)
    const signal = ctx.onTurn.mock.calls[0]![0].signal as AbortSignal
    expect(signal.aborted).toBe(false)
    expect(ctx.out.controls).not.toContain("interrupt")
  })

  it("is off when disabled", async () => {
    const ctx = setup({ bargeIn: { enabled: false } })
    await startSpeaking(ctx)
    await feed(ctx.pipeline, "quiet", GUARD_MS + 100)
    await feed(ctx.pipeline, "loud", 1200)
    expect(ctx.signals[0]!.aborted).toBe(false)
    expect(ctx.out.controls).not.toContain("interrupt")
  })

  it("fires once per interruption even if the caller keeps talking", async () => {
    const ctx = setup()
    await startSpeaking(ctx)
    await feed(ctx.pipeline, "quiet", GUARD_MS + 100)
    await feed(ctx.pipeline, "loud", 2000)
    expect(ctx.out.controls.filter(c => c === "interrupt")).toHaveLength(1)
  })

  it("treats the interrupting speech as a new utterance: kept, trimmed, answered", async () => {
    const ctx = setup({
      onTurn: async ({ text, onChunk, signal }) => {
        if (signal) ctx0.signals.push(signal)
        if (text === "bonjour") {
          await onChunk(ttsChunk(4000))
          await hangUntilAborted(signal)
        }
        return "ok"
      },
    })
    const ctx0 = ctx
    ctx.transcribe
      .mockResolvedValueOnce("bonjour")
      .mockResolvedValueOnce("arrête")
    await startSpeaking(ctx)
    await feed(ctx.pipeline, "quiet", GUARD_MS + 1000)
    await feed(ctx.pipeline, "loud", 900)
    expect(ctx.signals[0]!.aborted).toBe(true)
    await feed(ctx.pipeline, "quiet", 800)

    expect(ctx.transcribe).toHaveBeenCalledTimes(2)
    const second = ctx.transcribe.mock.calls[1]![0] as unknown as {
      pcm16: Int16Array
    }
    const ms = (second.pcm16.length / SR) * 1000
    // 900 ms of speech + 300 ms pre-roll + ~700 ms trailing silence, and none
    // of the 1.5 s of silence that piled up while the assistant was speaking.
    expect(ms).toBeGreaterThan(1700)
    expect(ms).toBeLessThan(2100)
    expect(ctx.onTurn).toHaveBeenCalledTimes(2)
    expect(ctx.onTurn.mock.calls[1]![0].text).toBe("arrête")
  })

  it("an intentional abort is not a failure: no error log, no assistant transcript", async () => {
    const ctx = setup()
    await startSpeaking(ctx)
    await feed(ctx.pipeline, "quiet", GUARD_MS + 100)
    await feed(ctx.pipeline, "loud", 400)
    await vi.advanceTimersByTimeAsync(50)
    expect(errors).not.toHaveBeenCalled()
    expect(ctx.transcripts.filter(t => t.role === "assistant")).toHaveLength(0)
    expect(abortError().name).toBe("AbortError")
  })

  it("logs the barge-in with speech and purged durations", async () => {
    const ctx = setup()
    await startSpeaking(ctx)
    await feed(ctx.pipeline, "quiet", GUARD_MS + 100)
    await feed(ctx.pipeline, "loud", 400)
    const line = logs.mock.calls
      .map(c => String(c[0]))
      .find(l => l.includes("barge-in triggered"))
    expect(line).toBeDefined()
    expect(line).toMatch(/speech_ms=\d+/)
    expect(line).toMatch(/purged_ms=\d+/)
    expect(line).toMatch(/utt=1/)
  })
})
