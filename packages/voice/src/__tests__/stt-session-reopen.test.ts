import { describe, expect, it } from "vitest"
import { openSttSession } from "../cascade/stt-session.js"
import type { SttProvider, SttStream } from "../types.js"

type Fake = SttStream & { drop: () => void; closedCalls: number }

function fakeStream(): Fake {
  const handlers: Record<string, Array<(...a: never[]) => void>> = {}
  const fire = (ev: string) => handlers[ev]?.forEach(h => (h as () => void)())
  let pending = 0
  const s: Fake = {
    closedCalls: 0,
    pushAudio() {},
    commit() {
      pending++
      queueMicrotask(() => {
        if (pending > 0) {
          pending--
          handlers.final?.forEach(h => (h as (t: { text: string }) => void)({ text: "salut" }))
        }
      })
    },
    on(ev: string, cb: (...a: never[]) => void) {
      ;(handlers[ev] ??= []).push(cb)
    },
    async close() {
      s.closedCalls++
    },
    drop: () => fire("closed"),
  } as Fake
  return s
}

function fakeProvider(failOpens: number[] = []) {
  const streams: Fake[] = []
  let calls = 0
  const provider = {
    slug: "fake",
    async openStream() {
      const n = calls++
      if (failOpens.includes(n)) throw new Error("no socket")
      const s = fakeStream()
      streams.push(s)
      return s
    },
  } as unknown as SttProvider
  return { provider, streams, calls: () => calls }
}
const opts = { sampleRate: 16000, finalTimeoutMs: 200 }
const tick = () => new Promise(r => setTimeout(r, 5))

describe("openSttSession reopen", () => {
  it("reopens the realtime stream after it closes, so the next turn is not a file fallback", async () => {
    const { provider, streams } = fakeProvider()
    const session = await openSttSession(provider, opts)
    expect(await session.commit()).toBe("salut")
    streams[0]!.drop()
    await tick()
    expect(streams).toHaveLength(2)
    expect(session.isReady()).toBe(true)
    expect(await session.commit()).toBe("salut")
  })

  it("stays down (file fallback) when the reopen fails", async () => {
    const { provider, streams } = fakeProvider([1])
    const session = await openSttSession(provider, opts)
    streams[0]!.drop()
    await tick()
    expect(session.isReady()).toBe(false)
    expect(await session.commit()).toBeNull()
  })

  it("does not reopen after close()", async () => {
    const { provider, streams, calls } = fakeProvider()
    const session = await openSttSession(provider, opts)
    session.close()
    streams[0]!.drop()
    await tick()
    expect(calls()).toBe(1)
    expect(session.isReady()).toBe(false)
  })
})
