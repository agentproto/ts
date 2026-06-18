import { describe, it, expect } from "vitest"
import type { AgentCliRuntime } from "../types.js"
import {
  makeAgentCliModel,
  composePrompt,
  datasetPreamble,
} from "../model.js"

/** A minimal fake AgentCliRuntime whose session replays a scripted ACP stream. */
function fakeRuntime(
  events: Array<Record<string, unknown>>,
  spy: {
    closed?: boolean
    sent?: unknown
    startOpts?: Record<string, unknown>
  } = {}
): AgentCliRuntime {
  return {
    definition: { id: "fake" },
    async start(startOpts?: Record<string, unknown>) {
      spy.startOpts = startOpts
      return {
        sessionId: "s1",
        async *send(message: unknown) {
          spy.sent = message
          for (const e of events) yield e
        },
        async cancel() {},
        async close() {
          spy.closed = true
        },
      }
    },
  } as unknown as AgentCliRuntime
}

describe("makeAgentCliModel", () => {
  it("concatenates text-delta events into the completion and closes the session", async () => {
    const spy: { closed?: boolean; sent?: unknown } = {}
    const runtime = fakeRuntime(
      [
        { kind: "text-delta", sessionId: "s1", text: "Hello" },
        { kind: "text-delta", sessionId: "s1", text: " world" },
        { kind: "turn-end", sessionId: "s1", reason: "completed" },
      ],
      spy
    )
    const out = await makeAgentCliModel(runtime).complete({
      system: "Sys.",
      prompt: "Ask.",
    })
    expect(out.result).toBe("Hello world")
    expect(spy.sent).toEqual({ role: "user", content: "Sys.\n\nAsk." })
    expect(spy.closed).toBe(true)
  })

  it("rejects on an error event", async () => {
    const runtime = fakeRuntime([{ kind: "error", error: { message: "boom" } }])
    await expect(
      makeAgentCliModel(runtime).complete({ prompt: "x" })
    ).rejects.toThrow(/fake model: boom/)
  })

  it("rejects when the turn ends non-completed", async () => {
    const runtime = fakeRuntime([
      { kind: "turn-end", sessionId: "s1", reason: "cancelled" },
    ])
    await expect(
      makeAgentCliModel(runtime).complete({ prompt: "x" })
    ).rejects.toThrow(/turn cancelled/)
  })

  it("honors an injectable runner without touching the runtime", async () => {
    const model = makeAgentCliModel(fakeRuntime([]), {
      run: async p => `echo:${p}`,
    })
    expect((await model.complete({ prompt: "ask" })).result).toBe("echo:ask")
  })

  it("file-reading tier: roots the session at datasetDir and prepends the access preamble", async () => {
    const spy: { startOpts?: Record<string, unknown> } = {}
    const runtime = fakeRuntime(
      [{ kind: "turn-end", sessionId: "s1", reason: "completed" }],
      spy
    )
    const seen: string[] = []
    const model = makeAgentCliModel(runtime, {
      datasetDir: "/data/eu-ai-act",
      run: async p => {
        seen.push(p)
        return "ok"
      },
    })
    await model.complete({ prompt: "Write chapter 1." })
    expect(seen[0]).toContain("/data/eu-ai-act")
    expect(seen[0]).toContain("file-reading tools")
    expect(seen[0]?.trimEnd().endsWith("Write chapter 1.")).toBe(true)
  })

  it("file-reading tier: default runner passes datasetDir as cwd to the runtime", async () => {
    const spy: { startOpts?: Record<string, unknown> } = {}
    const runtime = fakeRuntime(
      [{ kind: "turn-end", sessionId: "s1", reason: "completed" }],
      spy
    )
    await makeAgentCliModel(runtime, { datasetDir: "/data/x" }).complete({
      prompt: "x",
    })
    expect(spy.startOpts?.cwd).toBe("/data/x")
  })
})

describe("composePrompt / datasetPreamble", () => {
  it("composes system + prompt with no preamble when datasetDir is unset", () => {
    expect(composePrompt("Sys.", "Ask.")).toBe("Sys.\n\nAsk.")
    expect(composePrompt(undefined, "Ask.")).toBe("Ask.")
  })

  it("prepends the dataset preamble when datasetDir is set", () => {
    const out = composePrompt(undefined, "Ask.", "/d")
    expect(out.startsWith(datasetPreamble("/d"))).toBe(true)
    expect(out.endsWith("Ask.")).toBe(true)
  })
})
