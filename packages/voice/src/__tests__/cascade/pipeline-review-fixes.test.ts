// @ts-nocheck
// Ported from agentik-studio projects/simone/apps/voice/test/calls/pipeline-review-fixes.test.ts
// The expect blocks are unchanged from the studio original; only imports (and,
// where noted in the PR, injected provider labels) differ. Type checking is off
// for this file because the studio does not type-check its test files.
/**
 * Review follow-ups of the barge-in work: noise before the cut-in, the
 * watchdog vs long playback, the echo guard re-armed at each playback restart,
 * the cut-in RMS threshold and the timing logs of a deferred utterance.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createCallPipeline } from "../../cascade/pipeline.js"
import { streamTurnWithSentences } from "../../cascade/speak-turn.js"
import {
  feed,
  hangUntilAborted,
  makeOutbound,
  SR,
  ttsChunk,
} from "./pipeline-test-kit.js"

type TurnInput = {
  text: string
  onChunk: (pcm: Buffer) => void | Promise<void>
  signal?: AbortSignal
}
type TurnFn = (input: TurnInput) => Promise<string | void>

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

function setup(opts: {
  onTurn: TurnFn
  bargeIn?: Record<string, unknown>
  turnTimeoutMs?: number
  maxMs?: number
}) {
  const out = makeOutbound()
  const transcribe = vi.fn(async () => "bonjour")
  const transcripts: Array<{ text: string; role: string }> = []
  const onTurn = vi.fn(opts.onTurn)
  const pipeline = createCallPipeline({
    transport: out.transport,
    playback: out.playback,
    outboundQueueMaxMs: opts.maxMs ?? 0,
    sampleRate: SR,
    transcribe,
    onTurn: onTurn as never,
    onTranscript: (text: string, role: string) =>
      transcripts.push({ text, role }),
    bargeIn: { enabled: true, minSpeechMs: 300, guardMs: 500, ...opts.bargeIn },
    ...(opts.turnTimeoutMs !== undefined
      ? { turnTimeoutMs: opts.turnTimeoutMs }
      : {}),
    logPrefix: "[test]",
  } as never)
  return { out, pipeline, transcribe, onTurn, transcripts }
}

/** A sine whose RMS is about `amplitude / sqrt(2)`. */
function toneFrame(ms: number, amplitude: number): Int16Array {
  const n = Math.floor((SR * ms) / 1000)
  const o = new Int16Array(n)
  for (let i = 0; i < n; i++) {
    o[i] = Math.floor(Math.sin((2 * Math.PI * 440 * i) / SR) * amplitude)
  }
  return o
}

async function feedTone(
  p: ReturnType<typeof setup>["pipeline"],
  ms: number,
  amplitude: number
) {
  for (let t = 0; t < ms; t += 20) {
    await vi.advanceTimersByTimeAsync(20)
    p.pushFrame(toneFrame(20, amplitude))
  }
}

const wavMs = (call: unknown[]) =>
  ((call[0] as { pcm16: Int16Array }).pcm16.length / SR) * 1000

/** Turn that speaks 4 s then waits for the cut-in. */
const talkThenHang: TurnFn = async ({ onChunk, signal }) => {
  await onChunk(ttsChunk(4000))
  await hangUntilAborted(signal)
}

describe("review follow-ups", () => {
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

  describe("noise before the cut-in", () => {
    it("a short noise during the turn does not split the sentence that follows", async () => {
      const ctx = setup({
        onTurn: async input => {
          if (input.text === "bonjour" && ctx.onTurn.mock.calls.length === 1) {
            return talkThenHang(input)
          }
          return "ok"
        },
      })
      await feed(ctx.pipeline, "loud", 400)
      await feed(ctx.pipeline, "quiet", 800)
      expect(ctx.onTurn).toHaveBeenCalledTimes(1)
      await feed(ctx.pipeline, "quiet", 600)
      // Cough: 100 ms of energy, then more than 700 ms of silence.
      await feed(ctx.pipeline, "loud", 100)
      await feed(ctx.pipeline, "quiet", 800)
      // The real sentence starts while the assistant is still talking.
      await feed(ctx.pipeline, "loud", 1500)
      await feed(ctx.pipeline, "quiet", 800)
      await vi.advanceTimersByTimeAsync(100)

      expect(ctx.transcribe).toHaveBeenCalledTimes(2)
      expect(ctx.onTurn).toHaveBeenCalledTimes(2)
      const ms = wavMs(ctx.transcribe.mock.calls[1]!)
      // 300 pre-roll + 1500 sentence + 700 trailing silence; the cough and the
      // silence after it are gone.
      expect(ms).toBeGreaterThan(2300)
      expect(ms).toBeLessThan(2700)
    })

    it("does not trim a genuine phrase (at least minSpeechMs) that cut in", async () => {
      const ctx = setup({
        onTurn: async input =>
          ctx.onTurn.mock.calls.length === 1 ? talkThenHang(input) : "ok",
      })
      await feed(ctx.pipeline, "loud", 400)
      await feed(ctx.pipeline, "quiet", 800)
      await feed(ctx.pipeline, "quiet", 600)
      await feed(ctx.pipeline, "loud", 450)
      await feed(ctx.pipeline, "quiet", 800)
      await feed(ctx.pipeline, "loud", 900)
      await feed(ctx.pipeline, "quiet", 800)
      await vi.advanceTimersByTimeAsync(100)
      // The 450 ms phrase cut in on its own and is sent whole (preroll +
      // phrase + silence); the later 900 ms is a separate utterance.
      expect(ctx.transcribe).toHaveBeenCalledTimes(3)
      const first = wavMs(ctx.transcribe.mock.calls[1]!)
      expect(first).toBeGreaterThan(1300)
      expect(first).toBeLessThan(1650)
    })
  })

  describe("watchdog vs playback", () => {
    it("does not cut a reply longer than the turn timeout that plays normally", async () => {
      const signals: AbortSignal[] = []
      const ctx = setup({
        turnTimeoutMs: 120_000,
        bargeIn: { enabled: false },
        onTurn: async ({ onChunk, signal }) => {
          if (signal) signals.push(signal)
          // 150 s of speech, one second at a time, played as it arrives.
          for (let i = 0; i < 150; i++) {
            await onChunk(ttsChunk(1000))
            await sleep(1000)
            ctx.out.drain(1000)
          }
          return "longue réponse"
        },
      })
      await feed(ctx.pipeline, "loud", 400)
      await feed(ctx.pipeline, "quiet", 800)
      await vi.advanceTimersByTimeAsync(155_000)
      expect(signals[0]!.aborted).toBe(false)
      expect(ctx.out.audioSent).toHaveLength(150)
      expect(
        ctx.transcripts.filter(t => t.role === "assistant").map(t => t.text)
      ).toEqual(["longue réponse"])
      expect(errors).not.toHaveBeenCalled()
    })

    it("does not cut 150 s of audio queued at once while it is still draining", async () => {
      const signals: AbortSignal[] = []
      const ctx = setup({
        turnTimeoutMs: 120_000,
        bargeIn: { enabled: false },
        onTurn: async ({ onChunk, signal }) => {
          if (signal) signals.push(signal)
          await onChunk(ttsChunk(150_000))
          return "ok"
        },
      })
      await feed(ctx.pipeline, "loud", 400)
      await feed(ctx.pipeline, "quiet", 800)
      for (let i = 0; i < 150; i++) {
        await vi.advanceTimersByTimeAsync(1000)
        ctx.out.drain(1000)
      }
      await vi.advanceTimersByTimeAsync(100)
      expect(signals[0]!.aborted).toBe(false)
      expect(ctx.out.controls).not.toContain("interrupt")
      expect(errors).not.toHaveBeenCalled()
    })

    it("still aborts a brain that produces nothing for the whole timeout", async () => {
      const signals: AbortSignal[] = []
      const ctx = setup({
        turnTimeoutMs: 120_000,
        bargeIn: { enabled: false },
        onTurn: async ({ onChunk, signal }) => {
          if (signal) signals.push(signal)
          await onChunk(ttsChunk(500))
          await hangUntilAborted(signal)
        },
      })
      await feed(ctx.pipeline, "loud", 400)
      await feed(ctx.pipeline, "quiet", 800)
      await vi.advanceTimersByTimeAsync(119_000)
      expect(signals[0]!.aborted).toBe(false)
      await vi.advanceTimersByTimeAsync(2000)
      expect(signals[0]!.aborted).toBe(true)
    })
  })

  describe("echo guard re-armed at each playback restart", () => {
    // Filler, silence while a tool runs, then the real answer.
    function fillerThenAnswer() {
      return setup({
        onTurn: async ({ onChunk, signal }) => {
          if (ctx.onTurn.mock.calls.length > 1) return "ok"
          await onChunk(ttsChunk(300))
          await sleep(600)
          ctx.out.drain(300)
          await sleep(100)
          await onChunk(ttsChunk(4000))
          await hangUntilAborted(signal)
        },
      })
    }
    let ctx: ReturnType<typeof setup>

    it("does not count speech in the guard that follows a second playback start", async () => {
      ctx = fillerThenAnswer()
      await feed(ctx.pipeline, "loud", 400)
      await feed(ctx.pipeline, "quiet", 800)
      await feed(ctx.pipeline, "quiet", 700)
      expect(ctx.out.audioSent).toHaveLength(2)
      // 400 ms of echo-like energy right after the second start: inside the
      // restarted guard, so no barge-in even though the first audio is old.
      await feed(ctx.pipeline, "loud", 400)
      expect(ctx.out.controls).not.toContain("interrupt")
      // Speech that outlasts the guard does cut in.
      await feed(ctx.pipeline, "loud", 400)
      expect(ctx.out.controls.filter(c => c === "interrupt")).toHaveLength(1)
    })
  })

  describe("cut-in RMS threshold", () => {
    // feedTone amplitude A gives an RMS of about A / sqrt(2).
    const AMP_RMS_1200 = 1700
    const AMP_RMS_700 = 990

    async function speakingTurn(over: Parameters<typeof setup>[0]["bargeIn"]) {
      const ctx = setup({
        onTurn: talkThenHang,
        ...(over ? { bargeIn: over } : {}),
      })
      await feed(ctx.pipeline, "loud", 400)
      await feed(ctx.pipeline, "quiet", 800)
      await feed(ctx.pipeline, "quiet", 600)
      return ctx
    }

    it("a soft voice (RMS about 1200) cuts in with the default threshold", async () => {
      const ctx = await speakingTurn(undefined)
      await feedTone(ctx.pipeline, 500, AMP_RMS_1200)
      expect(ctx.out.controls.filter(c => c === "interrupt")).toHaveLength(1)
    })

    it("a faint voice (RMS about 700) does not cut in but is still VAD speech", async () => {
      const ctx = await speakingTurn(undefined)
      await feedTone(ctx.pipeline, 1500, AMP_RMS_700)
      expect(ctx.out.controls).not.toContain("interrupt")

      const alone = setup({ onTurn: async () => "ok" })
      await feedTone(alone.pipeline, 500, AMP_RMS_700)
      await feed(alone.pipeline, "quiet", 800)
      expect(alone.transcribe).toHaveBeenCalledTimes(1)
    })

    it("the threshold is configurable, both ways", async () => {
      const lower = await speakingTurn({ rms: 600 })
      await feedTone(lower.pipeline, 500, AMP_RMS_700)
      expect(lower.out.controls.filter(c => c === "interrupt")).toHaveLength(1)

      const higher = await speakingTurn({ rms: 2000 })
      await feedTone(higher.pipeline, 1500, AMP_RMS_1200)
      expect(higher.out.controls).not.toContain("interrupt")
    })

    it("logs the peak RMS of the run that cut in", async () => {
      const ctx = await speakingTurn(undefined)
      await feedTone(ctx.pipeline, 500, AMP_RMS_1200)
      const line = logs.mock.calls
        .map(c => String(c[0]))
        .find(l => l.includes("barge-in triggered"))!
      const peak = Number(/peak_rms=(\d+)/.exec(line)![1])
      expect(peak).toBeGreaterThan(1100)
      expect(peak).toBeLessThan(1300)
    })

    it("logs one aggregated caller-audio line per turn with peak and soft frames", async () => {
      const ctx = setup({
        bargeIn: { enabled: false },
        onTurn: async ({ onChunk }) => {
          await onChunk(ttsChunk(3000))
          await sleep(3000)
          ctx.out.drain(3000)
          return "ok"
        },
      })
      await feed(ctx.pipeline, "loud", 400)
      await feed(ctx.pipeline, "quiet", 800)
      await feedTone(ctx.pipeline, 400, AMP_RMS_700)
      await vi.advanceTimersByTimeAsync(4000)
      const lines = logs.mock.calls
        .map(c => String(c[0]))
        .filter(l => l.includes("caller audio utt=1"))
      expect(lines).toHaveLength(1)
      const peak = Number(/peak_rms=(\d+)/.exec(lines[0]!)![1])
      const soft = Number(/soft_frames=(\d+)/.exec(lines[0]!)![1])
      expect(peak).toBeGreaterThan(650)
      expect(peak).toBeLessThan(750)
      expect(soft).toBeGreaterThanOrEqual(19)
      expect(soft).toBeLessThanOrEqual(21)
      expect(lines[0]).toMatch(/barge_rms=1000/)
    })
  })

  describe("quiet that piles up during a turn", () => {
    function longReply() {
      const ctx = setup({
        bargeIn: { rms: 1000 },
        onTurn: async ({ onChunk }) => {
          if (ctx.onTurn.mock.calls.length > 1) return "ok"
          await onChunk(ttsChunk(12_000))
          await sleep(12_000)
          ctx.out.drain(12_000)
          return "ok"
        },
      })
      return ctx
    }

    it("a soft echo blip does not send the quiet of the whole reply to STT", async () => {
      const ctx = longReply()
      await feed(ctx.pipeline, "loud", 400)
      await feed(ctx.pipeline, "quiet", 800)
      await feed(ctx.pipeline, "quiet", 600)
      // 200 ms of leak between 500 and the barge-in threshold, then 11 s of quiet.
      await feedTone(ctx.pipeline, 200, 990)
      await feed(ctx.pipeline, "quiet", 10_000)
      await vi.advanceTimersByTimeAsync(2000)
      expect(ctx.transcribe).toHaveBeenCalledTimes(1)
      expect(ctx.onTurn).toHaveBeenCalledTimes(1)
    })

    it("a soft utterance during the reply is sent without the quiet around it", async () => {
      const ctx = longReply()
      await feed(ctx.pipeline, "loud", 400)
      await feed(ctx.pipeline, "quiet", 800)
      await feed(ctx.pipeline, "quiet", 600)
      await feedTone(ctx.pipeline, 600, 990)
      await feed(ctx.pipeline, "quiet", 10_000)
      await vi.advanceTimersByTimeAsync(2000)
      expect(ctx.transcribe).toHaveBeenCalledTimes(2)
      const ms = wavMs(ctx.transcribe.mock.calls[1]!)
      // 300 pre-roll + 600 soft speech + 700 end-of-speech silence.
      expect(ms).toBeGreaterThan(1400)
      expect(ms).toBeLessThan(1800)
    })
  })

  describe("timing logs of a deferred utterance", () => {
    it("measure from the real end of speech, not from when the turn got its turn", async () => {
      const ctx = setup({
        bargeIn: { enabled: false },
        onTurn: async ({ onChunk }) => {
          await onChunk(ttsChunk(500))
          await sleep(6000)
          ctx.out.drain(500)
          return "ok"
        },
      })
      await feed(ctx.pipeline, "loud", 400)
      await feed(ctx.pipeline, "quiet", 800)
      // Second utterance ends while the first turn is still running.
      await feed(ctx.pipeline, "loud", 500)
      await feed(ctx.pipeline, "quiet", 800)
      await vi.advanceTimersByTimeAsync(8000)
      expect(ctx.transcribe).toHaveBeenCalledTimes(2)

      const lines = logs.mock.calls.map(c => String(c[0]))
      const vad = lines.filter(l => l.includes("vad utterance utt=2"))[0]!
      const trailing = Number(/trailing_silence_ms=(\d+)/.exec(vad)![1])
      const speech = Number(/speech_ms=(\d+)/.exec(vad)![1])
      const queued = Number(/queued_ms=(\d+)/.exec(vad)![1])
      expect(trailing).toBeGreaterThanOrEqual(700)
      expect(trailing).toBeLessThan(900)
      expect(speech).toBeGreaterThanOrEqual(450)
      expect(speech).toBeLessThan(650)
      // It waited several seconds for the first turn.
      expect(queued).toBeGreaterThan(3000)

      const dispatch = lines.filter(l => l.includes("brain dispatch utt=2"))[0]!
      const since = Number(/since_speech_end_ms=(\d+)/.exec(dispatch)![1])
      expect(since).toBeGreaterThan(3000)
    })
  })

  describe("intentional abort through the sentence pipeline", () => {
    it("a barge-in during the TTS leaves no error log and no assistant transcript", async () => {
      const ctx = setup({
        onTurn: input =>
          streamTurnWithSentences(
            {
              brain: async ({ onDelta }) => {
                onDelta("Bonjour, comment allez-vous aujourd'hui ? ")
              },
              tts: async ({ onChunk, signal }) => {
                await onChunk(ttsChunk(4000))
                await hangUntilAborted(signal)
              },
              logPrefix: "[test]",
            },
            {
              text: input.text,
              onChunk: input.onChunk,
              ...(input.signal ? { signal: input.signal } : {}),
            }
          ),
      })
      await feed(ctx.pipeline, "loud", 400)
      await feed(ctx.pipeline, "quiet", 800)
      expect(ctx.out.queued()).toBeGreaterThan(3000)
      await feed(ctx.pipeline, "quiet", 600)
      await feed(ctx.pipeline, "loud", 400)
      await vi.advanceTimersByTimeAsync(100)

      expect(ctx.out.controls.filter(c => c === "interrupt")).toHaveLength(1)
      expect(errors).not.toHaveBeenCalled()
      expect(ctx.transcripts.filter(t => t.role === "assistant")).toHaveLength(
        0
      )
    })
  })
})
