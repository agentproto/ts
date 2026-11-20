import { describe, expect, it, vi } from "vitest"
import { BrainStalledError, consumeBrain } from "../cascade/brain-guard.js"
import { wrapSttStream } from "../cascade/stt-session.js"
import { VOICE_DEFAULTS } from "../defaults.js"
import { startRealtime } from "../realtime.js"
import { makeFakeRealtime, makeFakeStt, pcmFrame } from "../testing/fakes.js"
import { makeUsageMeter } from "../usage.js"

describe("consumeBrain", () => {
  it("passes every chunk and returns the text", async () => {
    const seen: string[] = []
    async function* g() { yield "a"; yield "b" }
    expect(await consumeBrain(g(), d => seen.push(d))).toBe("ab")
    expect(seen).toEqual(["a", "b"])
  })

  it("stalls on a quiet brain at the first chunk, then between chunks", async () => {
    vi.useFakeTimers()
    async function* quiet() {
      await new Promise(() => undefined)
      yield "x"
    }
    const p = consumeBrain(quiet(), () => undefined, { firstChunkMs: 100 })
    const rejected = expect(p).rejects.toMatchObject({ phase: "first-chunk" })
    await vi.advanceTimersByTimeAsync(150)
    await rejected
    async function* gap() { yield "x"; await new Promise(() => undefined); yield "y" }
    const p2 = consumeBrain(gap(), () => undefined, { firstChunkMs: 100, idleMs: 200 })
    const rejected2 = expect(p2).rejects.toBeInstanceOf(BrainStalledError)
    await vi.advanceTimersByTimeAsync(400)
    await rejected2
    vi.useRealTimers()
  })

  it("an aborted turn ends quietly and stops the source", async () => {
    const ctrl = new AbortController()
    let released = false
    // A source that observes the turn signal, as the brain contract asks.
    async function* g() {
      try {
        yield "a"
        await new Promise<void>(resolve => ctrl.signal.addEventListener("abort", () => resolve(), { once: true }))
      } finally {
        released = true
      }
    }
    const p = consumeBrain(g(), () => undefined, { signal: ctrl.signal })
    await new Promise(r => setTimeout(r, 5))
    ctrl.abort()
    expect(await p).toBe("a")
    await new Promise(r => setTimeout(r, 5))
    expect(released).toBe(true)
  })

  it("the default bounds are the kit defaults", () => {
    expect(VOICE_DEFAULTS.cascade.brain.firstChunkMs.value).toBeLessThan(VOICE_DEFAULTS.cascade.brain.turnTimeoutMs.value)
  })
})

describe("wrapSttStream", () => {
  it("commit resolves with the next final; null on timeout, error and closed", async () => {
    vi.useFakeTimers()
    const stt = makeFakeStt({ finals: ["un", "deux"] })
    const session = wrapSttStream(await stt.openStream({ sampleRate: 16000 }), { sampleRate: 16000, finalTimeoutMs: 100 })
    session.pushAudio(new Int16Array(160).fill(5))
    const first = session.commit()
    await vi.advanceTimersByTimeAsync(1)
    expect(await first).toBe("un")
    const silent = makeFakeStt({ silent: true })
    const s2 = wrapSttStream(await silent.openStream({ sampleRate: 16000 }), { sampleRate: 16000, finalTimeoutMs: 100 })
    const timedOut = s2.commit()
    await vi.advanceTimersByTimeAsync(150)
    expect(await timedOut).toBeNull()
    s2.close()
    expect(s2.isReady()).toBe(false)
    expect(await s2.commit()).toBeNull()
    vi.useRealTimers()
  })

  it("discard() drops the final owed to the discarded utterance", async () => {
    const stt = makeFakeStt({ finals: ["echo", "vrai"] })
    const session = wrapSttStream(await stt.openStream({ sampleRate: 16000 }), { sampleRate: 16000, finalTimeoutMs: 1000 })
    session.discard()
    await new Promise(r => setTimeout(r, 1))
    session.pushAudio(new Int16Array(160).fill(5))
    expect(await session.commit()).toBe("vrai")
  })
})

describe("wrapSttStream: discard and concurrent commits", () => {
  const controllable = () => {
    const finals: Array<(t: { text: string }) => void> = []
    let commits = 0
    const fake = {
      pushAudio() {},
      commit() { commits++ },
      async close() {},
      on(event: string, cb: never) { if (event === "final") finals.push(cb) },
    }
    return { fake, deliver: (text: string) => finals.forEach(cb => cb({ text })), commits: () => commits }
  }

  it("a discarded utterance whose flush never answers does not swallow the next real final", async () => {
    vi.useFakeTimers()
    const c = controllable()
    const session = wrapSttStream(c.fake as never, { sampleRate: 16000, finalTimeoutMs: 100 })
    session.discard() // the vendor never answers this flush
    await vi.advanceTimersByTimeAsync(500)
    const next = session.commit(1000)
    c.deliver("réel")
    expect(await next).toBe("réel")
    vi.useRealTimers()
  })

  it("a discard that is answered still swallows its own final", async () => {
    const c = controllable()
    const session = wrapSttStream(c.fake as never, { sampleRate: 16000, finalTimeoutMs: 1000 })
    session.discard()
    c.deliver("écho")
    const next = session.commit(1000)
    c.deliver("réel")
    expect(await next).toBe("réel")
  })

  it("a second commit() while one is pending settles the first with null instead of orphaning it", async () => {
    const c = controllable()
    const session = wrapSttStream(c.fake as never, { sampleRate: 16000, finalTimeoutMs: 1000 })
    const first = session.commit(1000)
    const second = session.commit(1000)
    expect(await first).toBeNull()
    c.deliver("deuxième")
    expect(await second).toBe("deuxième")
  })

  it("the timeout of an earlier commit does not settle a later one", async () => {
    vi.useFakeTimers()
    const c = controllable()
    const session = wrapSttStream(c.fake as never, { sampleRate: 16000, finalTimeoutMs: 1000 })
    void session.commit(100)
    await vi.advanceTimersByTimeAsync(50)
    const second = session.commit(1000)
    await vi.advanceTimersByTimeAsync(80) // the first commit's 100 ms timer fires here
    c.deliver("tard")
    expect(await second).toBe("tard")
    vi.useRealTimers()
  })
})

describe("startRealtime", () => {
  it("delegates to the provider and keeps usage final after close", async () => {
    const provider = makeFakeRealtime()
    const session = await startRealtime(provider, {
      emit: { audio() {}, userTranscript() {}, assistantTranscript() {}, toolCallStart() {}, toolCallEnd() {}, interrupt() {}, responseComplete() {}, error() {} },
      hooks: {},
    })
    session.pushAudio(pcmFrame(1000, 16000))
    const live = session.getUsage!()!
    expect(live.entries[0]!.audioSeconds).toBeCloseTo(1)
    await session.close()
    const final = session.getUsage!()!
    expect(final.entries[0]!.audioSeconds).toBeCloseTo(1)
    session.pushAudio(pcmFrame(1000, 16000))
    expect(session.getUsage!()!.entries[0]!.audioSeconds).toBeCloseTo(1)
  })

  it("refuses a provider that returns a cascade session", async () => {
    const provider = makeFakeRealtime()
    const bad = { ...provider, start: async (o: never) => ({ ...(await provider.start(o)), engine: "cascade" as const }) }
    await expect(startRealtime(bad, { emit: {} as never, hooks: {} })).rejects.toThrow(/cascade/)
  })
})

describe("makeUsageMeter", () => {
  it("accumulates per stage and provider, ignores bad numbers, and freezes at seal", () => {
    let t = 0
    const m = makeUsageMeter("cascade", () => t)
    m.addSttSeconds("a", 1.5)
    m.addSttSeconds("a", -3)
    m.addSttSeconds("a", Number.NaN)
    m.addSttSeconds("a", 0.5)
    m.addTtsCharacters("b", 10.4)
    m.addRealtime("c", { tokens: { audioIn: 3 }, reportedCostUsd: 0.01 })
    t = 4000
    const snap = m.snapshot()
    expect(snap.wallSeconds).toBe(4)
    expect(snap.entries.find(e => e.stage === "stt")?.audioSeconds).toBe(2)
    expect(snap.entries.find(e => e.stage === "tts")?.characters).toBe(10)
    expect(snap.entries.find(e => e.stage === "realtime")?.tokens?.audioIn).toBe(3)
    expect(snap.entries.find(e => e.stage === "realtime")?.reportedCostUsd).toBe(0.01)
    m.seal()
    t = 9000
    m.addSttSeconds("a", 5)
    expect(m.snapshot().wallSeconds).toBe(4)
    expect(m.snapshot().entries.find(e => e.stage === "stt")?.audioSeconds).toBe(2)
  })
})
