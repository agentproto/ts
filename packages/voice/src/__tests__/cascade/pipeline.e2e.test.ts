// @ts-nocheck
// Type checking is off for this file: it is kept close to a verbatim test suite.
/**
 * T11 e2e: WebRTC call session factory + sequential cascade with mocked
 * STT / onTurn / TTS. No real WebRTC, Redis, or providers - the transport
 * is exercised through the pipeline boundary (PCM frames in, audio messages
 * out via transport.send), which is what the cascade actually depends on.
 */
import { describe, expect, it, vi, beforeEach } from "vitest"
import { createCallPipeline } from "../../cascade/pipeline.js"
import type { CallPipeline } from "../../cascade/pipeline.js"

function sineFrame(freq: number, sampleRate: number, ms: number): Int16Array {
  const n = Math.floor((sampleRate * ms) / 1000)
  const out = new Int16Array(n)
  for (let i = 0; i < n; i++) {
    out[i] = Math.floor(Math.sin((2 * Math.PI * freq * i) / sampleRate) * 8000)
  }
  return out
}

function silenceFrame(sampleRate: number, ms: number): Int16Array {
  return new Int16Array(Math.floor((sampleRate * ms) / 1000))
}

function makeTransport() {
  const sent: Array<{ type: string; audio?: string; format?: string }> = []
  let open = true
  return {
    sent,
    isOpen: () => open,
    setOpen: (v: boolean) => {
      open = v
    },
    send: vi.fn(async (msg: never) => {
      sent.push(msg as never)
    }),
  }
}

describe("createCallPipeline sequential cascade", () => {
  let pipeline: CallPipeline
  let transport: ReturnType<typeof makeTransport>
  let transcribe: ReturnType<typeof vi.fn>
  let onTurn: ReturnType<typeof vi.fn>
  let transcripts: Array<{ text: string; role: string }>

  beforeEach(() => {
    vi.clearAllMocks()
    transport = makeTransport()
    transcribe = vi.fn(async () => "Bonjour Demo")
    onTurn = vi.fn(async ({ onChunk }: { onChunk: (p: Buffer) => void }) => {
      onChunk(Buffer.from("salut"))
      return "Salut !"
    })
    transcripts = []
    pipeline = createCallPipeline({
      transport,
      sampleRate: 16_000,
      silenceEndMs: 50,
      transcribe,
      onTurn,
      onTranscript: (text, role) => transcripts.push({ text, role }),
      logPrefix: "[test]",
    })
  })

  it("speech then silence triggers one STT + one onTurn", async () => {
    // 200 ms speech + 80 ms silence > silenceEndMs=50
    for (let i = 0; i < 10; i++) pipeline.pushFrame(sineFrame(440, 16_000, 20))
    await new Promise(r => setTimeout(r, 80))
    for (let i = 0; i < 5; i++) pipeline.pushFrame(silenceFrame(16_000, 20))
    // Allow the async processUtterance to settle
    await new Promise(r => setTimeout(r, 50))
    await pipeline.flush()

    expect(transcribe).toHaveBeenCalledTimes(1)
    expect(onTurn).toHaveBeenCalledTimes(1)
    expect(onTurn.mock.calls[0]![0].text).toBe("Bonjour Demo")
    expect(transport.send).toHaveBeenCalled()
    const audioMsg = transport.sent[0]!
    expect(audioMsg.type).toBe("audio")
    expect(audioMsg.format).toBe("pcm16")
    // TTS is PCM 24 kHz; stamping the inbound 16 kHz rate plays it 1.5x slow.
    expect((audioMsg as { sampleRate?: number }).sampleRate).toBe(24_000)
    expect(transcripts).toEqual([
      { text: "Bonjour Demo", role: "user" },
      { text: "Salut !", role: "assistant" },
    ])
  })

  it("pure silence does not trigger STT", async () => {
    for (let i = 0; i < 20; i++) pipeline.pushFrame(silenceFrame(16_000, 20))
    await pipeline.flush()
    expect(transcribe).not.toHaveBeenCalled()
    expect(onTurn).not.toHaveBeenCalled()
  })

  it("two utterances are processed sequentially", async () => {
    transcribe.mockResolvedValueOnce("premier").mockResolvedValueOnce("second")
    // utterance 1
    for (let i = 0; i < 5; i++) pipeline.pushFrame(sineFrame(440, 16_000, 20))
    await new Promise(r => setTimeout(r, 80))
    for (let i = 0; i < 5; i++) pipeline.pushFrame(silenceFrame(16_000, 20))
    await new Promise(r => setTimeout(r, 50))
    // utterance 2
    for (let i = 0; i < 5; i++) pipeline.pushFrame(sineFrame(880, 16_000, 20))
    await new Promise(r => setTimeout(r, 80))
    for (let i = 0; i < 5; i++) pipeline.pushFrame(silenceFrame(16_000, 20))
    await new Promise(r => setTimeout(r, 50))
    await pipeline.flush()

    expect(transcribe).toHaveBeenCalledTimes(2)
    expect(onTurn).toHaveBeenCalledTimes(2)
    expect(onTurn.mock.calls[0]![0].text).toBe("premier")
    expect(onTurn.mock.calls[1]![0].text).toBe("second")
  })

  it("close() stops further processing", async () => {
    pipeline.close()
    for (let i = 0; i < 10; i++) pipeline.pushFrame(sineFrame(440, 16_000, 20))
    await pipeline.flush()
    expect(transcribe).not.toHaveBeenCalled()
  })

  it("transport closed mid-turn does not send audio", async () => {
    onTurn.mockImplementationOnce(
      async ({ onChunk }: { onChunk: (p: Buffer) => void }) => {
        transport.setOpen(false)
        onChunk(Buffer.from("late"))
        return "late"
      }
    )
    for (let i = 0; i < 5; i++) pipeline.pushFrame(sineFrame(440, 16_000, 20))
    await new Promise(r => setTimeout(r, 80))
    for (let i = 0; i < 5; i++) pipeline.pushFrame(silenceFrame(16_000, 20))
    await new Promise(r => setTimeout(r, 50))
    await pipeline.flush()
    expect(transport.send).not.toHaveBeenCalled()
  })
})

describe("createCallPipeline stall recovery", () => {
  async function say(
    pipeline: CallPipeline,
    freq: number,
    settleMs = 60
  ): Promise<void> {
    for (let i = 0; i < 5; i++) pipeline.pushFrame(sineFrame(freq, 16_000, 20))
    await new Promise(r => setTimeout(r, 80))
    for (let i = 0; i < 5; i++) pipeline.pushFrame(silenceFrame(16_000, 20))
    await new Promise(r => setTimeout(r, settleMs))
  }

  it("releases `processing` when onTurn rejects, so the next utterance runs", async () => {
    const transport = makeTransport()
    const transcribe = vi
      .fn()
      .mockResolvedValueOnce("premier")
      .mockResolvedValueOnce("second")
    const onTurn = vi
      .fn()
      .mockRejectedValueOnce(new Error("brain timeout"))
      .mockResolvedValueOnce("ok")
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    const pipeline = createCallPipeline({
      transport,
      sampleRate: 16_000,
      silenceEndMs: 50,
      transcribe,
      onTurn,
      logPrefix: "[test]",
    })

    await say(pipeline, 440)
    await say(pipeline, 880)
    await pipeline.flush()

    expect(onTurn).toHaveBeenCalledTimes(2)
    expect(onTurn.mock.calls[1]![0].text).toBe("second")
    expect(errSpy).toHaveBeenCalledWith(
      "[test] utterance failed",
      expect.objectContaining({ err: "brain timeout" })
    )
    errSpy.mockRestore()
  })

  it("watchdog abandons a hung turn, drops its late audio, and serves the next one", async () => {
    const transport = makeTransport()
    const transcribe = vi
      .fn()
      .mockResolvedValueOnce("premier")
      .mockResolvedValueOnce("second")
    let releaseHung!: () => void
    const hung = new Promise<void>(r => (releaseHung = r))
    const onTurn = vi
      .fn()
      .mockImplementationOnce(
        async ({ onChunk }: { onChunk: (p: Buffer) => Promise<void> }) => {
          await hung
          await onChunk(Buffer.from("stale"))
          return "stale reply"
        }
      )
      .mockImplementationOnce(
        async ({ onChunk }: { onChunk: (p: Buffer) => Promise<void> }) => {
          await onChunk(Buffer.from("fresh"))
          return "fresh reply"
        }
      )
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    const pipeline = createCallPipeline({
      transport,
      sampleRate: 16_000,
      silenceEndMs: 50,
      turnTimeoutMs: 150,
      transcribe,
      onTurn,
      logPrefix: "[test]",
    })

    await say(pipeline, 440, 10)
    await new Promise(r => setTimeout(r, 200)) // watchdog fires
    await say(pipeline, 880)
    releaseHung()
    await new Promise(r => setTimeout(r, 20))
    await pipeline.flush()

    expect(onTurn).toHaveBeenCalledTimes(2)
    const audio = transport.sent.map(m =>
      Buffer.from((m as { audio?: string }).audio ?? "", "base64").toString()
    )
    expect(audio).toEqual(["fresh"])
    expect(pipeline.lastAssistantText).toBe("fresh reply")
    errSpy.mockRestore()
  })
  it("a transcribe that resolves after the watchdog cannot revive the abandoned turn", async () => {
    const transport = makeTransport()
    let releaseStt!: (t: string) => void
    let sttSignal: AbortSignal | undefined
    const transcribe = vi
      .fn()
      .mockImplementationOnce(
        (_audio: unknown, opts?: { signal: AbortSignal }) => {
          sttSignal = opts?.signal
          return new Promise<string>(r => (releaseStt = r))
        }
      )
      .mockResolvedValueOnce("fresh")
    const onTurn = vi.fn(async () => "ok")
    const transcripts: string[] = []
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    const pipeline = createCallPipeline({
      transport,
      sampleRate: 16_000,
      silenceEndMs: 50,
      turnTimeoutMs: 150,
      transcribe,
      onTurn,
      onTranscript: (text, role) => {
        if (role === "user") transcripts.push(text)
      },
      logPrefix: "[test]",
    })

    await say(pipeline, 440, 10)
    await new Promise(r => setTimeout(r, 200)) // watchdog fires, STT still hung
    expect(sttSignal?.aborted).toBe(true)
    await say(pipeline, 880)
    expect(pipeline.lastUserTranscript).toBe("fresh")

    releaseStt("stale")
    await new Promise(r => setTimeout(r, 20))
    await pipeline.flush()

    expect(onTurn).toHaveBeenCalledTimes(1)
    expect(onTurn.mock.calls[0]![0].text).toBe("fresh")
    expect(transcripts).toEqual(["fresh"])
    expect(pipeline.lastUserTranscript).toBe("fresh")
    errSpy.mockRestore()
  })

  it("gives onTurn an AbortSignal that fires on watchdog", async () => {
    const transport = makeTransport()
    let turnSignal: AbortSignal | undefined
    const onTurn = vi.fn(
      (input: { signal?: AbortSignal }) =>
        new Promise<string>(() => {
          turnSignal = input.signal
        })
    )
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    const pipeline = createCallPipeline({
      transport,
      sampleRate: 16_000,
      silenceEndMs: 50,
      turnTimeoutMs: 100,
      transcribe: async () => "salut",
      onTurn,
      logPrefix: "[test]",
    })

    await say(pipeline, 440, 10)
    expect(turnSignal?.aborted).toBe(false)
    await new Promise(r => setTimeout(r, 150))
    expect(turnSignal?.aborted).toBe(true)
    errSpy.mockRestore()
  })

  it("close() aborts the in-flight turn without logging an error", async () => {
    const transport = makeTransport()
    let turnSignal: AbortSignal | undefined
    const onTurn = vi.fn(
      (input: { signal?: AbortSignal }) =>
        new Promise<string>((_resolve, reject) => {
          turnSignal = input.signal
          input.signal?.addEventListener("abort", () =>
            reject(new Error("aborted"))
          )
        })
    )
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    const pipeline = createCallPipeline({
      transport,
      sampleRate: 16_000,
      silenceEndMs: 50,
      transcribe: async () => "salut",
      onTurn,
      logPrefix: "[test]",
    })

    await say(pipeline, 440, 10)
    pipeline.close()
    await new Promise(r => setTimeout(r, 20))
    expect(turnSignal?.aborted).toBe(true)
    expect(errSpy).not.toHaveBeenCalled()
    errSpy.mockRestore()
  })
})

describe("createCallPipeline speech arriving during a running turn", () => {
  async function say(pipeline: CallPipeline, freq: number): Promise<void> {
    for (let i = 0; i < 5; i++) pipeline.pushFrame(sineFrame(freq, 16_000, 20))
    await new Promise(r => setTimeout(r, 80))
    for (let i = 0; i < 5; i++) pipeline.pushFrame(silenceFrame(16_000, 20))
    await new Promise(r => setTimeout(r, 10))
  }

  it("transcribes speech said during a turn as soon as the turn settles, with no new inbound frame", async () => {
    const transport = makeTransport()
    const transcribe = vi
      .fn()
      .mockResolvedValueOnce("au revoir")
      .mockResolvedValueOnce("salut allo ca va")
    let releaseTurn!: () => void
    const gate = new Promise<void>(r => (releaseTurn = r))
    const onTurn = vi
      .fn()
      .mockImplementationOnce(async () => {
        await gate
        return "a plus"
      })
      .mockResolvedValueOnce("ca va et toi")
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
    const pipeline = createCallPipeline({
      transport,
      sampleRate: 16_000,
      silenceEndMs: 50,
      transcribe,
      onTurn,
      logPrefix: "[test]",
    })

    await say(pipeline, 440) // turn 1 starts and hangs on the gate
    await say(pipeline, 880) // spoken while turn 1 is still running
    expect(transcribe).toHaveBeenCalledTimes(1)

    releaseTurn()
    // No pushFrame from here on: the queued speech must still be picked up.
    await new Promise(r => setTimeout(r, 50))
    await pipeline.flush()

    expect(transcribe).toHaveBeenCalledTimes(2)
    expect(onTurn).toHaveBeenCalledTimes(2)
    expect(onTurn.mock.calls[1]![0].text).toBe("salut allo ca va")
    const queuedLogs = warnSpy.mock.calls.filter(c =>
      String(c[0]).includes("queued for after it")
    )
    expect(queuedLogs).toHaveLength(1)
    warnSpy.mockRestore()
  })

  it("logs when a call closes with speech that was never transcribed", async () => {
    const transport = makeTransport()
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    const onTurn = vi.fn(
      (input: { signal?: AbortSignal }) =>
        new Promise<string>((_resolve, reject) => {
          input.signal?.addEventListener("abort", () =>
            reject(new Error("aborted"))
          )
        })
    )
    const pipeline = createCallPipeline({
      transport,
      sampleRate: 16_000,
      silenceEndMs: 50,
      transcribe: async () => "au revoir",
      onTurn,
      logPrefix: "[test]",
    })

    await say(pipeline, 440)
    await say(pipeline, 880)
    pipeline.close()

    const dropped = warnSpy.mock.calls.filter(c =>
      String(c[0]).includes("untranscribed speech")
    )
    expect(dropped).toHaveLength(1)
    expect(dropped[0]![1]).toMatchObject({ queuedBehindTurn: true })
    warnSpy.mockRestore()
    errSpy.mockRestore()
  })
})
