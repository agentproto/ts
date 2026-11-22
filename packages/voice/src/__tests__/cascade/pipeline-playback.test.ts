// @ts-nocheck
// Type checking is off for this file: it is kept close to a verbatim test suite.
/**
 * Bounded outbound queue and turn end tied to the end of playback.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createCallPipeline } from "../../cascade/pipeline.js"
import { feed, makeOutbound, SR, ttsChunk } from "./pipeline-test-kit.js"

type TurnInput = {
  text: string
  onChunk: (pcm: Buffer) => void | Promise<void>
  signal?: AbortSignal
}

function setup(opts: {
  onTurn: (input: TurnInput) => Promise<string | void>
  maxMs?: number
  withPlayback?: boolean
}) {
  const out = makeOutbound()
  const onTurn = vi.fn(opts.onTurn)
  const pipeline = createCallPipeline({
    transport: out.transport,
    ...(opts.withPlayback === false ? {} : { playback: out.playback }),
    outboundQueueMaxMs: opts.maxMs ?? 0,
    sampleRate: SR,
    transcribe: async () => "bonjour",
    onTurn: onTurn as never,
    bargeIn: { enabled: false },
    logPrefix: "[test]",
  } as never)
  return { out, pipeline, onTurn }
}

async function oneUtterance(p: ReturnType<typeof setup>["pipeline"]) {
  await feed(p, "loud", 400)
  await feed(p, "quiet", 800)
}

describe("outbound playback", () => {
  let warns: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    vi.useFakeTimers()
    vi.spyOn(console, "log").mockImplementation(() => {})
    vi.spyOn(console, "error").mockImplementation(() => {})
    warns = vi.spyOn(console, "warn").mockImplementation(() => {})
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it("keeps the turn open until the queue has drained, so the next utterance waits", async () => {
    const ctx = setup({
      onTurn: async ({ onChunk }) => {
        await onChunk(ttsChunk(3000))
        return "ok"
      },
    })
    await oneUtterance(ctx.pipeline)
    expect(ctx.onTurn).toHaveBeenCalledTimes(1)
    await oneUtterance(ctx.pipeline)
    expect(ctx.onTurn).toHaveBeenCalledTimes(1)

    ctx.out.drain(3000)
    await vi.advanceTimersByTimeAsync(0)
    expect(ctx.onTurn).toHaveBeenCalledTimes(2)
  })

  it("does not wait for playback on a turn that produced no audio", async () => {
    const ctx = setup({ onTurn: async () => "ok" })
    await oneUtterance(ctx.pipeline)
    await oneUtterance(ctx.pipeline)
    expect(ctx.onTurn).toHaveBeenCalledTimes(2)
    expect(ctx.out.playback.waitBelow).not.toHaveBeenCalled()
  })

  it("does not wait when there is no playback probe (legacy transports)", async () => {
    const ctx = setup({
      withPlayback: false,
      onTurn: async ({ onChunk }) => {
        await onChunk(ttsChunk(3000))
        return "ok"
      },
    })
    await oneUtterance(ctx.pipeline)
    await oneUtterance(ctx.pipeline)
    expect(ctx.onTurn).toHaveBeenCalledTimes(2)
  })

  it("applies back-pressure past the bound instead of dropping audio", async () => {
    let second: "pending" | "done" = "pending"
    const ctx = setup({
      maxMs: 1000,
      onTurn: async ({ onChunk }) => {
        await onChunk(ttsChunk(800))
        await onChunk(ttsChunk(800)).then(() => {
          second = "done"
        })
        return "ok"
      },
    })
    await oneUtterance(ctx.pipeline)
    expect(ctx.out.audioSent).toEqual([800, 800])
    expect(second).toBe("pending")

    ctx.out.drain(700)
    await vi.advanceTimersByTimeAsync(0)
    expect(second).toBe("done")
    expect(ctx.out.audioSent).toEqual([800, 800])
  })

  it("treats a transport that never drains as stalled: purge, abort, release", async () => {
    const ctx = setup({
      onTurn: async ({ onChunk }) => {
        await onChunk(ttsChunk(1000))
        return "ok"
      },
    })
    await oneUtterance(ctx.pipeline)
    expect(ctx.out.controls).not.toContain("interrupt")

    await vi.advanceTimersByTimeAsync(1000 + 3000 + 100)
    expect(ctx.out.controls).toContain("interrupt")
    expect(
      warns.mock.calls.some(c => String(c[0]).includes("playback stalled"))
    ).toBe(true)

    await oneUtterance(ctx.pipeline)
    expect(ctx.onTurn).toHaveBeenCalledTimes(2)
  })

  it("aborts the turn when back-pressure itself never clears", async () => {
    let aborted = false
    const ctx = setup({
      maxMs: 500,
      onTurn: async ({ onChunk, signal }) => {
        await onChunk(ttsChunk(2000))
        aborted = signal?.aborted ?? false
        return "ok"
      },
    })
    await oneUtterance(ctx.pipeline)
    await vi.advanceTimersByTimeAsync(1500 + 5000 + 100)
    expect(aborted).toBe(true)
    expect(ctx.out.controls).toContain("interrupt")
  })
})
