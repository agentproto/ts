import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { startCascade } from "../cascade/start-cascade.js"
import { startRealtime } from "../realtime.js"
import { makeFakeRealtime, makeFakeStt, makeFakeTts } from "../testing/fakes.js"
import type { VoiceEmit, VoiceUsage } from "../types.js"

const emit: VoiceEmit = {
  audio: () => undefined,
  userTranscript: () => undefined,
  assistantTranscript: () => undefined,
  toolCallStart: () => undefined,
  toolCallEnd: () => undefined,
  interrupt: () => undefined,
  responseComplete: () => undefined,
  error: () => undefined,
}
async function* noWords() {
  yield ""
}

describe("onUsage", () => {
  beforeEach(() => vi.spyOn(console, "log").mockImplementation(() => undefined))
  afterEach(() => vi.restoreAllMocks())

  it("cascade: receives the final record once at close, equal to getUsage()", async () => {
    const seen: VoiceUsage[] = []
    const session = await startCascade({
      emit,
      hooks: {},
      stt: makeFakeStt(),
      tts: makeFakeTts(),
      brain: noWords,
      onUsage: u => void seen.push(u),
    })
    expect(seen).toHaveLength(0)
    await session.close()
    await session.close()
    expect(seen).toHaveLength(1)
    expect(seen[0]).toEqual(session.getUsage!())
    expect(seen[0]!.engine).toBe("cascade")
  })

  it("cascade: a rejecting or throwing onUsage never fails the close", async () => {
    for (const onUsage of [
      async () => {
        throw new Error("sink down")
      },
      () => {
        throw new Error("sink down")
      },
    ]) {
      const session = await startCascade({
        emit,
        hooks: {},
        stt: makeFakeStt(),
        tts: makeFakeTts(),
        brain: noWords,
        onUsage,
      })
      await expect(session.close()).resolves.toBeUndefined()
    }
  })

  it("realtime: receives the final record once after close", async () => {
    const seen: VoiceUsage[] = []
    const session = await startRealtime(makeFakeRealtime(), {
      emit,
      hooks: {},
      onUsage: u => void seen.push(u),
    })
    await session.close()
    await session.close()
    expect(seen).toHaveLength(1)
    expect(seen[0]!.engine).toBe("realtime")
    expect(seen[0]).toEqual(session.getUsage!())
  })
})
