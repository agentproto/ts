// @ts-nocheck
// Type checking is off for this file: it is kept close to a verbatim test suite.
/**
 * Pipeline + streaming STT integration. A fake SttSession proves the audio is
 * pushed as the caller speaks, the final is used without a WAV upload, whisper
 * is only used as a fallback, TTS echo is discarded, and utterance order is
 * preserved.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createCallPipeline } from "../../cascade/pipeline.js"
import type { SttSession } from "../../cascade/stt-session.js"
import {
  feed,
  hangUntilAborted,
  makeOutbound,
  SR,
  ttsChunk,
} from "./pipeline-test-kit.js"

type FakeStt = SttSession & {
  pushes: Int16Array[]
  commits: number
  discards: number
  setReady: (v: boolean) => void
  setFinals: (finals: Array<string | null>) => void
}

function makeFakeStt(): FakeStt {
  let ready = true
  let finals: Array<string | null> = ["transcription Scribe"]
  const pushes: Int16Array[] = []
  let commits = 0
  let discards = 0
  const finalListeners: Array<
    (f: { text: string; provider: "scribe"; at: number }) => void
  > = []
  const fake: FakeStt = {
    pushes,
    get commits() {
      return commits
    },
    get discards() {
      return discards
    },
    setReady(v) {
      ready = v
    },
    setFinals(v) {
      finals = v
    },
    pushAudio(pcm) {
      if (ready) pushes.push(pcm)
    },
    async commit() {
      commits++
      if (!ready) return null
      const text = finals.length > 0 ? finals.shift()! : null
      if (text) {
        for (const cb of finalListeners) {
          cb({ text, provider: "scribe", at: Date.now() })
        }
      }
      return text
    },
    discard() {
      discards++
    },
    onFinal(cb) {
      finalListeners.push(cb)
    },
    onReady() {},
    onError() {},
    isReady: () => ready,
    close: vi.fn(),
  }
  return fake
}

function setup(
  over: {
    ready?: boolean
    onSttUsage?: (u: {
      provider: "scribe" | "whisper"
      seconds: number
    }) => void
  } = {}
) {
  const out = makeOutbound()
  const stt = makeFakeStt()
  stt.setReady(over.ready ?? true)
  const transcribe = vi.fn(async () => "transcription Whisper")
  const onTurn = vi.fn(
    async ({ onChunk }: { onChunk: (b: Buffer) => void | Promise<void> }) => {
      await onChunk(ttsChunk(1500))
      return "réponse"
    }
  )
  const pipeline = createCallPipeline({
    sttStreamLabel: "scribe",
    sttFileLabel: "whisper",
    transport: out.transport,
    playback: out.playback,
    sampleRate: SR,
    silenceEndMs: 50,
    transcribe,
    sttStream: stt,
    sttFinalTimeoutMs: 500,
    ...(over.onSttUsage ? { onSttUsage: over.onSttUsage } : {}),
    onTurn: onTurn as never,
    bargeIn: { enabled: true, minSpeechMs: 300, guardMs: 500 },
    logPrefix: "[test]",
  })
  return { out, stt, transcribe, onTurn, pipeline }
}

async function say(
  pipeline: ReturnType<typeof setup>["pipeline"],
  freq: number,
  settleMs = 80
): Promise<void> {
  for (let i = 0; i < 5; i++) {
    pipeline.pushFrame(
      Int16Array.from({ length: 320 }, (_, j) =>
        Math.floor(Math.sin((2 * Math.PI * freq * j) / SR) * 8000)
      )
    )
  }
  await new Promise(r => setTimeout(r, 60))
  for (let i = 0; i < 5; i++) pipeline.pushFrame(new Int16Array(320))
  await new Promise(r => setTimeout(r, settleMs))
}

const sttDoneLines = () =>
  vi
    .mocked(console.log)
    .mock.calls.map(c => String(c[0]))
    .filter(l => l.includes("stt done"))

const pushedSamples = (stt: FakeStt) =>
  stt.pushes.reduce((n, pcm) => n + pcm.length, 0)

const msToSamples = (ms: number) => Math.floor((SR * ms) / 1000)

describe("pipeline streaming STT", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {})
    vi.spyOn(console, "warn").mockImplementation(() => {})
    vi.spyOn(console, "error").mockImplementation(() => {})
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("pushes audio during speech and uses the final without a WAV upload", async () => {
    const ctx = setup()
    ctx.stt.setFinals(["Bonjour Scribe"])
    await say(ctx.pipeline, 440)
    await ctx.pipeline.flush()

    expect(ctx.stt.pushes.length).toBeGreaterThan(5)
    expect(ctx.stt.commits).toBe(1)
    expect(ctx.transcribe).not.toHaveBeenCalled()
    expect(ctx.onTurn).toHaveBeenCalledTimes(1)
    expect(ctx.onTurn.mock.calls[0]![0].text).toBe("Bonjour Scribe")
  })

  it("reports the transcribed audio seconds and the provider once per utterance", async () => {
    const usage: Array<{ provider: string; seconds: number }> = []
    const ctx = setup({ onSttUsage: u => usage.push(u) })
    ctx.stt.setFinals(["Bonjour Scribe"])
    await say(ctx.pipeline, 440)
    await ctx.pipeline.flush()
    expect(usage).toHaveLength(1)
    expect(usage[0]!.provider).toBe("scribe")
    expect(usage[0]!.seconds).toBeGreaterThan(0.05)
    expect(usage[0]!.seconds).toBeLessThan(5)
  })

  it("reports the whisper provider when the stream fell back", async () => {
    const usage: Array<{ provider: string; seconds: number }> = []
    const ctx = setup({ onSttUsage: u => usage.push(u) })
    ctx.stt.setFinals([null])
    await say(ctx.pipeline, 440)
    await ctx.pipeline.flush()
    expect(usage).toHaveLength(1)
    expect(usage[0]!.provider).toBe("whisper")
  })

  it("falls back to whisper when the streaming final times out", async () => {
    const ctx = setup()
    ctx.stt.setFinals([null])
    await say(ctx.pipeline, 440)
    await ctx.pipeline.flush()

    expect(ctx.stt.commits).toBe(1)
    expect(ctx.transcribe).toHaveBeenCalledTimes(1)
    expect(ctx.onTurn).toHaveBeenCalledTimes(1)
    expect(ctx.onTurn.mock.calls[0]![0].text).toBe("transcription Whisper")
  })

  it("falls back to whisper without streaming when the session is not ready", async () => {
    const ctx = setup({ ready: false })
    await say(ctx.pipeline, 440)
    await ctx.pipeline.flush()

    expect(ctx.stt.pushes).toHaveLength(0)
    expect(ctx.stt.commits).toBe(0)
    expect(ctx.transcribe).toHaveBeenCalledTimes(1)
    expect(ctx.onTurn.mock.calls[0]![0].text).toBe("transcription Whisper")
  })

  it("discards TTS echo instead of transcribing it during playback", async () => {
    vi.useFakeTimers()
    try {
      const out = makeOutbound()
      const stt = makeFakeStt()
      const transcribe = vi.fn(async () => "transcription Whisper")
      let release!: () => void
      const hung = new Promise<void>(r => (release = r))
      const onTurn = vi.fn(
        async ({
          onChunk,
        }: {
          onChunk: (b: Buffer) => void | Promise<void>
        }) => {
          await onChunk(ttsChunk(4000))
          await hung
        }
      )
      const pipeline = createCallPipeline({
    sttStreamLabel: "scribe",
    sttFileLabel: "whisper",
        transport: out.transport,
        playback: out.playback,
        sampleRate: SR,
        silenceEndMs: 50,
        transcribe,
        sttStream: stt,
        sttFinalTimeoutMs: 500,
        onTurn: onTurn as never,
        bargeIn: { enabled: true, minSpeechMs: 300, guardMs: 500 },
        logPrefix: "[test]",
      })

      // First utterance starts a turn with 4 s of audio queued.
      await feed(pipeline, "loud", 200)
      await feed(pipeline, "quiet", 300)
      expect(onTurn).toHaveBeenCalledTimes(1)
      expect(out.queued()).toBeGreaterThan(3000)
      const commitsAfterFirst = stt.commits

      // A 100 ms blip during playback: below the 300 ms barge-in minimum, so it
      // is echo/noise and must be discarded rather than transcribed.
      await feed(pipeline, "loud", 100)
      await feed(pipeline, "quiet", 120)
      expect(stt.discards).toBeGreaterThan(0)
      expect(stt.commits).toBe(commitsAfterFirst)
      expect(transcribe).not.toHaveBeenCalled()

      release()
      pipeline.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it("preserves utterance order", async () => {
    const ctx = setup()
    ctx.stt.setFinals(["premier", "second"])
    await say(ctx.pipeline, 440)
    // Let the first turn's queued audio drain so the second utterance is not
    // mistaken for TTS echo during playback.
    ctx.out.drain(2000)
    await new Promise(r => setTimeout(r, 20))
    await say(ctx.pipeline, 880)
    ctx.out.drain(2000)
    await ctx.pipeline.flush()

    expect(ctx.stt.commits).toBe(2)
    expect(ctx.onTurn).toHaveBeenCalledTimes(2)
    expect(ctx.onTurn.mock.calls[0]![0].text).toBe("premier")
    expect(ctx.onTurn.mock.calls[1]![0].text).toBe("second")
    expect(ctx.transcribe).not.toHaveBeenCalled()
  })

  describe("utterances deferred behind a running turn", () => {
    function setupDeferred(bargeIn: boolean) {
      const out = makeOutbound()
      const stt = makeFakeStt()
      const transcribe = vi.fn(async () => "transcription Whisper")
      let release!: () => void
      const hung = new Promise<void>(r => (release = r))
      const onTurn = vi
        .fn()
        .mockImplementationOnce(
          async ({
            onChunk,
          }: {
            onChunk: (b: Buffer) => void | Promise<void>
          }) => {
            await onChunk(ttsChunk(4000))
            await hung
          }
        )
        .mockResolvedValue("ok")
      const pipeline = createCallPipeline({
    sttStreamLabel: "scribe",
    sttFileLabel: "whisper",
        transport: out.transport,
        playback: out.playback,
        sampleRate: SR,
        silenceEndMs: 50,
        transcribe,
        sttStream: stt,
        sttFinalTimeoutMs: 500,
        onTurn: onTurn as never,
        bargeIn: { enabled: bargeIn, minSpeechMs: 300, guardMs: 500 },
        logPrefix: "[test]",
      })
      return { out, stt, transcribe, onTurn, pipeline, release }
    }

    it("uses the Scribe final when the deferred utterance was fully streamed", async () => {
      vi.useFakeTimers()
      try {
        const ctx = setupDeferred(false)
        ctx.stt.setFinals(["premier", "deuxieme"])
        await feed(ctx.pipeline, "loud", 200)
        await feed(ctx.pipeline, "quiet", 300)
        expect(ctx.onTurn).toHaveBeenCalledTimes(1)

        await feed(ctx.pipeline, "loud", 400)
        await feed(ctx.pipeline, "quiet", 200)
        ctx.release()
        ctx.out.drain(10_000)
        await vi.advanceTimersByTimeAsync(50)
        ctx.out.drain(10_000)
        await vi.advanceTimersByTimeAsync(50)
        await ctx.pipeline.flush()

        expect(ctx.onTurn).toHaveBeenCalledTimes(2)
        expect(ctx.onTurn.mock.calls[1]![0].text).toBe("deuxieme")
        expect(ctx.transcribe).not.toHaveBeenCalled()
        ctx.pipeline.close()
      } finally {
        vi.useRealTimers()
      }
    })

    // The caller pauses past the VAD end while a turn runs, then goes on
    // talking: streaming pauses on the silence and resumes on the speech, so
    // Scribe hears all of it and serves the utterance without whisper.
    async function resumeBehindTurn(
      ctx: ReturnType<typeof setupDeferred>,
      between?: () => void | Promise<void>
    ) {
      await feed(ctx.pipeline, "loud", 200)
      await feed(ctx.pipeline, "quiet", 300)
      expect(ctx.onTurn).toHaveBeenCalledTimes(1)
      const pushedBefore = pushedSamples(ctx.stt)
      await feed(ctx.pipeline, "loud", 400)
      await feed(ctx.pipeline, "quiet", 1000)
      await between?.()
      await feed(ctx.pipeline, "loud", 400)
      await feed(ctx.pipeline, "quiet", 200)
      ctx.release()
      ctx.out.drain(10_000)
      await vi.advanceTimersByTimeAsync(50)
      ctx.out.drain(10_000)
      await vi.advanceTimersByTimeAsync(50)
      await ctx.pipeline.flush()
      return pushedSamples(ctx.stt) - pushedBefore
    }

    it("keeps Scribe live when the caller resumes after the deferred utterance ended", async () => {
      vi.useFakeTimers()
      try {
        const ctx = setupDeferred(false)
        ctx.stt.setFinals(["premier", "phrase A puis phrase B"])
        const pushed = await resumeBehindTurn(ctx)

        expect(ctx.onTurn).toHaveBeenCalledTimes(2)
        expect(ctx.onTurn.mock.calls[1]![0].text).toBe("phrase A puis phrase B")
        expect(ctx.transcribe).not.toHaveBeenCalled()
        expect(ctx.stt.discards).toBe(0)
        expect(sttDoneLines().at(-1)).toMatch(/provider=scribe fallback=0$/)
        // Both sentences reached Scribe; the 1 s pause was held back except
        // for its pre-roll, so the resume does not stream more silence.
        expect(pushed).toBeGreaterThanOrEqual(msToSamples(800))
        expect(pushed).toBeLessThan(msToSamples(800 + 1000))
        ctx.pipeline.close()
      } finally {
        vi.useRealTimers()
      }
    })

    it("still discards TTS echo with the stream live, and the resumed speech stays on Scribe", async () => {
      vi.useFakeTimers()
      try {
        const ctx = setupDeferred(false)
        ctx.stt.setFinals(["premier", "la vraie reprise"])
        await feed(ctx.pipeline, "loud", 200)
        await feed(ctx.pipeline, "quiet", 300)
        expect(ctx.onTurn).toHaveBeenCalledTimes(1)
        const commitsAfterFirst = ctx.stt.commits

        // Echo blip while the assistant is talking: flushed, never committed.
        await feed(ctx.pipeline, "loud", 100)
        await feed(ctx.pipeline, "quiet", 500)
        expect(ctx.stt.discards).toBe(1)
        expect(ctx.stt.commits).toBe(commitsAfterFirst)

        // Then the caller really talks, with a pause past the VAD end.
        await feed(ctx.pipeline, "loud", 400)
        await feed(ctx.pipeline, "quiet", 120)
        await feed(ctx.pipeline, "loud", 300)
        await feed(ctx.pipeline, "quiet", 200)
        ctx.release()
        ctx.out.drain(10_000)
        await vi.advanceTimersByTimeAsync(50)
        ctx.out.drain(10_000)
        await vi.advanceTimersByTimeAsync(50)
        await ctx.pipeline.flush()

        // No turn for the echo, the real speech is served by Scribe.
        expect(ctx.onTurn).toHaveBeenCalledTimes(2)
        expect(ctx.onTurn.mock.calls[1]![0].text).toBe("la vraie reprise")
        expect(ctx.transcribe).not.toHaveBeenCalled()
        expect(ctx.stt.discards).toBe(1)
        ctx.pipeline.close()
      } finally {
        vi.useRealTimers()
      }
    })

    it("falls back to whisper when Scribe answers the resumed utterance with blank text", async () => {
      vi.useFakeTimers()
      try {
        const ctx = setupDeferred(false)
        ctx.stt.setFinals(["premier", "  "])
        await resumeBehindTurn(ctx)

        expect(ctx.onTurn.mock.calls[1]![0].text).toBe("transcription Whisper")
        expect(ctx.transcribe).toHaveBeenCalledTimes(1)
        expect(sttDoneLines().at(-1)).toMatch(
          /provider=whisper fallback=1 reason=empty$/
        )
        ctx.pipeline.close()
      } finally {
        vi.useRealTimers()
      }
    })

    it("falls back to whisper when Scribe is down as the caller resumes", async () => {
      vi.useFakeTimers()
      try {
        const ctx = setupDeferred(false)
        ctx.stt.setFinals(["premier", "ne doit pas servir"])
        await resumeBehindTurn(ctx, () => ctx.stt.setReady(false))

        expect(ctx.onTurn.mock.calls[1]![0].text).toBe("transcription Whisper")
        expect(ctx.transcribe).toHaveBeenCalledTimes(1)
        expect(sttDoneLines().at(-1)).toMatch(
          /provider=whisper fallback=1 reason=dirty dirty_cause=socket_dropped/
        )
        ctx.pipeline.close()
      } finally {
        vi.useRealTimers()
      }
    })

    it("falls back to whisper when the socket drops in the middle of an utterance", async () => {
      vi.useFakeTimers()
      try {
        const ctx = setupDeferred(false)
        ctx.stt.setFinals(["ne doit pas servir"])
        await feed(ctx.pipeline, "loud", 100)
        ctx.stt.setReady(false)
        await feed(ctx.pipeline, "loud", 100)
        ctx.stt.setReady(true)
        await feed(ctx.pipeline, "loud", 100)
        await feed(ctx.pipeline, "quiet", 300)

        expect(ctx.onTurn.mock.calls[0]![0].text).toBe("transcription Whisper")
        expect(ctx.transcribe).toHaveBeenCalledTimes(1)
        ctx.release()
        ctx.pipeline.close()
      } finally {
        vi.useRealTimers()
      }
    })

    it("falls back to whisper when the socket dropped during the held-back pause", async () => {
      vi.useFakeTimers()
      try {
        const ctx = setupDeferred(false)
        ctx.stt.setFinals(["premier", "ne doit pas servir"])
        await resumeBehindTurn(ctx, async () => {
          ctx.stt.setReady(false)
          await feed(ctx.pipeline, "quiet", 100)
          ctx.stt.setReady(true)
        })

        expect(ctx.onTurn.mock.calls[1]![0].text).toBe("transcription Whisper")
        expect(sttDoneLines().at(-1)).toMatch(
          /provider=whisper fallback=1 reason=dirty dirty_cause=socket_dropped/
        )
        ctx.pipeline.close()
      } finally {
        vi.useRealTimers()
      }
    })
  })

  describe("barge-in and whisper fallback reasons", () => {
    function setupTurns(sttReady = true, silenceEndMs = 50) {
      const out = makeOutbound()
      const stt = makeFakeStt()
      stt.setReady(sttReady)
      const transcribe = vi.fn(async () => "transcription Whisper")
      const onTurn = vi
        .fn()
        .mockImplementationOnce(
          async ({
            onChunk,
            signal,
          }: {
            onChunk: (b: Buffer) => void | Promise<void>
            signal?: AbortSignal
          }) => {
            await onChunk(ttsChunk(4000))
            await hangUntilAborted(signal)
          }
        )
        .mockResolvedValue("ok")
      const pipeline = createCallPipeline({
    sttStreamLabel: "scribe",
    sttFileLabel: "whisper",
        transport: out.transport,
        playback: out.playback,
        sampleRate: SR,
        silenceEndMs,
        transcribe,
        sttStream: stt,
        sttFinalTimeoutMs: 500,
        onTurn: onTurn as never,
        bargeIn: { enabled: true, minSpeechMs: 300, guardMs: 500 },
        logPrefix: "[test]",
      })
      return { out, stt, transcribe, onTurn, pipeline }
    }

    it("keeps the Scribe final after a barge-in that only trimmed silence", async () => {
      vi.useFakeTimers()
      try {
        const ctx = setupTurns()
        ctx.stt.setFinals(["premier", "deuxieme"])
        await feed(ctx.pipeline, "loud", 400)
        await feed(ctx.pipeline, "quiet", 400)
        expect(ctx.onTurn).toHaveBeenCalledTimes(1)

        // The caller starts talking inside the echo guard, so the barge-in
        // fires 160 ms later than the speech start: the cut-in trims the
        // pre-roll silence that Scribe already received.
        await feed(ctx.pipeline, "loud", 700)
        await feed(ctx.pipeline, "quiet", 300)
        await ctx.pipeline.flush()

        expect(ctx.out.controls).toContain("interrupt")
        expect(ctx.onTurn).toHaveBeenCalledTimes(2)
        expect(ctx.onTurn.mock.calls[1]![0].text).toBe("deuxieme")
        expect(ctx.transcribe).not.toHaveBeenCalled()
        expect(ctx.stt.discards).toBe(0)
        expect(sttDoneLines().at(-1)).toMatch(/provider=scribe fallback=0/)
        ctx.pipeline.close()
      } finally {
        vi.useRealTimers()
      }
    })

    it("still falls back to whisper when loud audio Scribe heard was trimmed", async () => {
      vi.useFakeTimers()
      try {
        const ctx = setupTurns(true, 700)
        ctx.stt.setFinals(["premier", "ne doit pas servir"])
        await feed(ctx.pipeline, "loud", 400)
        await feed(ctx.pipeline, "quiet", 800)
        expect(ctx.onTurn).toHaveBeenCalledTimes(1)

        // A short cough streamed to Scribe, a pause too long to join the run
        // and too short to be dropped as a blip, then the real cut-in: the
        // cough is trimmed from the buffer but Scribe heard it.
        await feed(ctx.pipeline, "quiet", 700)
        await feed(ctx.pipeline, "loud", 100)
        await feed(ctx.pipeline, "quiet", 380)
        await feed(ctx.pipeline, "loud", 500)
        await feed(ctx.pipeline, "quiet", 800)
        await ctx.pipeline.flush()

        expect(ctx.out.controls).toContain("interrupt")
        expect(ctx.onTurn.mock.calls[1]![0].text).toBe("transcription Whisper")
        expect(ctx.stt.discards).toBe(1)
        expect(sttDoneLines().at(-1)).toMatch(
          /provider=whisper fallback=1 reason=dirty dirty_cause=trimmed_speech/
        )
        ctx.pipeline.close()
      } finally {
        vi.useRealTimers()
      }
    })

    it("a barge-in after a pause behind the turn cuts the reply and keeps the Scribe final", async () => {
      vi.useFakeTimers()
      try {
        const ctx = setupTurns()
        ctx.stt.setFinals(["premier", "deuxieme"])
        await feed(ctx.pipeline, "loud", 400)
        await feed(ctx.pipeline, "quiet", 100)
        expect(ctx.onTurn).toHaveBeenCalledTimes(1)

        // Sentence A inside the echo guard (no barge-in), a pause past the
        // VAD end (deferred behind the turn), then the caller goes on talking
        // over the assistant: that run cuts the reply.
        await feed(ctx.pipeline, "loud", 400)
        await feed(ctx.pipeline, "quiet", 120)
        await feed(ctx.pipeline, "loud", 600)
        expect(ctx.out.controls).toContain("interrupt")
        await feed(ctx.pipeline, "quiet", 300)
        await ctx.pipeline.flush()

        expect(ctx.onTurn).toHaveBeenCalledTimes(2)
        expect(ctx.onTurn.mock.calls[1]![0].text).toBe("deuxieme")
        expect(ctx.transcribe).not.toHaveBeenCalled()
        expect(ctx.stt.discards).toBe(0)
        expect(sttDoneLines().at(-1)).toMatch(/provider=scribe fallback=0$/)
        ctx.pipeline.close()
      } finally {
        vi.useRealTimers()
      }
    })

    it("logs reason=timeout and fallback=1 when Scribe gives no final", async () => {
      vi.useFakeTimers()
      try {
        const ctx = setupTurns()
        ctx.stt.setFinals([null])
        await feed(ctx.pipeline, "loud", 400)
        await feed(ctx.pipeline, "quiet", 200)
        expect(sttDoneLines()[0]).toMatch(
          /provider=whisper fallback=1 reason=timeout/
        )
        ctx.pipeline.close()
      } finally {
        vi.useRealTimers()
      }
    })

    it("logs reason=not_ready when the session was down at the start of the utterance", async () => {
      vi.useFakeTimers()
      try {
        const ctx = setupTurns(false)
        await feed(ctx.pipeline, "loud", 400)
        await feed(ctx.pipeline, "quiet", 200)
        expect(sttDoneLines()[0]).toMatch(
          /provider=whisper fallback=1 reason=not_ready/
        )
        ctx.pipeline.close()
      } finally {
        vi.useRealTimers()
      }
    })

    it("logs reason=dirty with its cause when the socket dropped mid-utterance", async () => {
      vi.useFakeTimers()
      try {
        const ctx = setupTurns()
        await feed(ctx.pipeline, "loud", 100)
        ctx.stt.setReady(false)
        await feed(ctx.pipeline, "loud", 100)
        ctx.stt.setReady(true)
        await feed(ctx.pipeline, "loud", 100)
        await feed(ctx.pipeline, "quiet", 200)
        expect(sttDoneLines()[0]).toMatch(
          /provider=whisper fallback=1 reason=dirty dirty_cause=socket_dropped/
        )
        ctx.pipeline.close()
      } finally {
        vi.useRealTimers()
      }
    })

    it("a Scribe-served utterance reports fallback=0 and no reason", async () => {
      vi.useFakeTimers()
      try {
        const ctx = setupTurns()
        await feed(ctx.pipeline, "loud", 400)
        await feed(ctx.pipeline, "quiet", 200)
        const line = sttDoneLines()[0]!
        expect(line).toMatch(/provider=scribe fallback=0$/)
        ctx.pipeline.close()
      } finally {
        vi.useRealTimers()
      }
    })
  })
})
