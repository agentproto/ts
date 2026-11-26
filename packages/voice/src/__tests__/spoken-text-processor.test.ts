import { describe, expect, it } from "vitest"
import { spokenTextProcessor } from "../text/index.js"
import { createProcessorRuntime } from "../processors.js"
import { makeReferenceProcessorSession } from "../testing/index.js"

const signal = new AbortController().signal

/** Run chunks through the real runtime, one turn, and return what reaches the TTS. */
async function through(chunks: string[], opts = {}, utteranceId = 1): Promise<string> {
  const rt = createProcessorRuntime({ processors: [spokenTextProcessor({ locale: "en", ...opts })], callId: "t" })
  let out = ""
  for (const text of chunks) {
    for (const c of await rt.process("textOut", { text }, { signal, utteranceId })) out += c.text
  }
  for (const c of await rt.process("textOut", { text: "", end: true }, { signal, utteranceId })) out += c.text
  return out
}

describe("spoken-text transformer", () => {
  it("is a named textOut transformer that modifies text", () => {
    const p = spokenTextProcessor()
    expect([p.kind, p.name, p.hook, p.modifies]).toEqual(["transformer", "spoken-text", "textOut", ["text"]])
  })

  it("does not cut a number between two chunks", async () => {
    const spoken = await through(["It costs 12", "00 dollars. Thanks", " a lot."])
    expect(spoken).toContain("one thousand two hundred dollars")
    expect(spoken).not.toMatch(/\btwelve/i)
  })

  it("does not split a decimal at its dot", async () => {
    expect((await through(["Pi is 3.", "14 roughly."])).replace(/\s+/g, " ")).toContain("three point one four")
  })

  it("holds an unfinished sentence until the end chunk, then flushes it", async () => {
    const rt = createProcessorRuntime({ processors: [spokenTextProcessor({ locale: "en" })], callId: "t" })
    const mid = await rt.process("textOut", { text: "Pay 5 dollars" }, { signal, utteranceId: 1 })
    expect(mid).toEqual([])
    const last = await rt.process("textOut", { text: "", end: true }, { signal, utteranceId: 1 })
    expect(last.map(c => c.text).join("")).toBe("Pay five dollars")
    expect(last.at(-1)?.end).toBe(true)
  })

  it("passes brain events through untouched", async () => {
    const rt = createProcessorRuntime({ processors: [spokenTextProcessor()], callId: "t" })
    const ev = { text: "", event: { type: "activity" as const } }
    expect(await rt.process("textOut", ev, { signal, utteranceId: 1 })).toEqual([ev])
  })

  it("drops text held for a turn that was cut when the next turn starts", async () => {
    const rt = createProcessorRuntime({ processors: [spokenTextProcessor({ locale: "en" })], callId: "t" })
    await rt.process("textOut", { text: "Old turn half sentence" }, { signal, utteranceId: 1 })
    const next = [
      ...(await rt.process("textOut", { text: "New one." }, { signal, utteranceId: 2 })),
      ...(await rt.process("textOut", { text: "", end: true }, { signal, utteranceId: 2 })),
    ]
    const text = next.map(c => c.text).join("")
    expect(text).toContain("New one.")
    expect(text).not.toContain("Old turn")
  })

  it("applies host labels", async () => {
    expect(await through(["Voice sent. Hello."], { stripLabels: ["Voice sent"] })).toBe("Hello.")
  })
})

describe("spoken-text transformer in a cascade session", () => {
  async function* brain() {
    yield "Il y a 12"
    yield "00 € à payer. "
    yield "Merci."
  }

  it("speaks the processed text, the host reads the raw reply", async () => {
    const s = await makeReferenceProcessorSession([spokenTextProcessor({ locale: "fr" })], { brain })
    await s.start()
    await s.ended()
    const spoken = s.tts.join("")
    expect(spoken).toContain("mille deux cents euros")
    expect(spoken).not.toContain("€")
    expect(s.events.find(e => e.type === "assistant")?.text).toContain("12")
    expect(s.processorEvents.filter(e => e.type === "error")).toEqual([])
    await s.close()
  })
})
