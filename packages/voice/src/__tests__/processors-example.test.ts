/**
 * The two custom processors shown in the README ("Writing an overlay"), run for
 * real: a `glossary` transformer on reply text, built by a closure over the
 * caller's word list, and a `gain` transformer on outbound audio.
 */
import { describe, expect, it } from "vitest"
import {
  createProcessorRuntime,
  defineTransformer,
  type AudioFrame,
  type VoiceProcessors,
} from "../index.js"
import { makeReferenceProcessorSession, pcmFrame } from "../testing/index.js"

/** Replace words the TTS says badly with a respelling. List supplied by the caller. */
const glossary = (entries: Record<string, string>) =>
  defineTransformer({
    name: "glossary",
    hook: "textOut",
    modifies: ["text:glossary"],
    run: chunk => {
      let text = chunk.text
      for (const [word, spoken] of Object.entries(entries)) text = text.split(word).join(spoken)
      return text === chunk.text ? chunk : { ...chunk, text }
    },
  })

/** Multiply PCM16 samples, clipped to the 16-bit range. */
const gain = (factor: number) =>
  defineTransformer({
    name: "gain",
    hook: "audioOut",
    modifies: ["audio:gain"],
    run: (frame: AudioFrame) => {
      const src = new Int16Array(frame.pcm16)
      const out = new Int16Array(src.length)
      for (let i = 0; i < src.length; i++) out[i] = Math.max(-32768, Math.min(32767, Math.round(src[i]! * factor)))
      return { ...frame, pcm16: out.buffer as ArrayBuffer }
    },
  })

async function* reply() {
  yield "Ask the gnu about SQL. "
}

describe("custom processor example: glossary on reply text", () => {
  it("changes what is spoken, not what the host reads", async () => {
    const processors: VoiceProcessors = [glossary({ SQL: "sequel", gnu: "new" })]
    const s = await makeReferenceProcessorSession(processors, { brain: reply })
    await s.start()
    await s.ended()
    expect(s.tts.join("")).toContain("Ask the new about sequel.")
    expect(s.events.find(e => e.type === "assistant")?.text).toContain("gnu about SQL")
    await s.close()
  })

  it("composes after another transformer only with an explicit after", async () => {
    const upper = defineTransformer({
      name: "upper",
      hook: "textOut",
      modifies: ["text:glossary"],
      run: c => ({ ...c, text: c.text.toUpperCase() }),
    })
    await expect(makeReferenceProcessorSession([glossary({ a: "b" }), upper])).rejects.toMatchObject({ code: "conflict" })
  })
})

describe("custom processor example: gain on outbound audio (reserved point, run on the runtime)", () => {
  it("scales samples and clips at the 16-bit range", async () => {
    const rt = createProcessorRuntime({ processors: [gain(2)], callId: "test" })
    const frame = pcmFrame(20, 24_000)
    const view = new Int16Array(frame.pcm16)
    view[0] = 1000
    view[1] = -1000
    view[2] = 30_000
    view[3] = -30_000
    const [out] = await rt.process("audioOut", frame, { signal: new AbortController().signal })
    const o = new Int16Array(out!.pcm16)
    expect([o[0], o[1], o[2], o[3]]).toEqual([2000, -2000, 32767, -32768])
    expect(out!.sampleRate).toBe(frame.sampleRate)
  })

  it("fails open on an invalid frame (odd byte length)", async () => {
    const events: string[] = []
    const bad = defineTransformer({
      name: "odd",
      hook: "audioOut",
      modifies: ["audio:x"],
      run: f => ({ ...f, pcm16: new ArrayBuffer(3) }),
    })
    const rt = createProcessorRuntime({ processors: [bad], callId: "t", onEvent: e => events.push(e.type) })
    const frame = pcmFrame(20, 24_000)
    const [out] = await rt.process("audioOut", frame, { signal: new AbortController().signal })
    expect(out).toBe(frame)
    expect(events).toEqual(["error"])
  })
})
