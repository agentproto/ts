// @ts-nocheck
// Ported from agentik-studio projects/simone/apps/voice/test/calls/stream-turn-tts-chars.test.ts
// The expect blocks are unchanged from the studio original; only imports (and,
// where noted in the PR, injected provider labels) differ. Type checking is off
// for this file because the studio does not type-check its test files.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  streamTurnWithSentences,
  type CallTtsStreamHandle,
  type CallTtsStreamOpener,
} from "../../cascade/speak-turn.js"

const SECRET = "SECRET-REPLY-TEXT-7373"

function fakeWs(opts: { closeBeforeAudio?: boolean } = {}) {
  let resolveClosed!: () => void
  const closed = new Promise<void>(res => {
    resolveClosed = res
  })
  const state = { pushes: [] as string[], ends: 0 }
  let onChunk: ((c: Buffer) => void | Promise<void>) | undefined
  let hadAudio = false
  const handle: CallTtsStreamHandle = {
    ready: Promise.resolve(),
    closed,
    pushText(d) {
      state.pushes.push(d)
      if (opts.closeBeforeAudio) return
      hadAudio = true
      void onChunk?.(Buffer.alloc(4800, 1))
    },
    async end() {
      state.ends++
      resolveClosed()
    },
    abort() {
      resolveClosed()
    },
    hadAudio: () => hadAudio,
    connectCount: () => 1,
  }
  const opener: CallTtsStreamOpener = {
    open: input => {
      onChunk = input.onChunk
      input.signal?.addEventListener("abort", () => handle.abort(), {
        once: true,
      })
      return handle
    },
  }
  return { opener, state, closeNow: () => resolveClosed() }
}

const charLines = () =>
  vi
    .mocked(console.log)
    .mock.calls.map(c => String(c[0]))
    .filter(l => l.includes("tts chars"))

describe("streamTurnWithSentences: tts chars per turn", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {})
    vi.spyOn(console, "warn").mockImplementation(() => {})
    vi.spyOn(console, "error").mockImplementation(() => {})
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("ws mode: one line with the chars and pushes sent to the socket, no text", async () => {
    const ws = fakeWs()
    const deltas = [`${SECRET} un. `, "Deux. "]
    await streamTurnWithSentences(
      {
        brain: async input => {
          for (const d of deltas) input.onDelta(d)
          return deltas.join("")
        },
        tts: async () => undefined,
        ttsStream: ws.opener,
        logPrefix: "[t]",
      },
      { text: SECRET, utteranceId: 7, onChunk: () => undefined }
    )
    const lines = charLines()
    expect(lines).toEqual([
      `[t] tts chars utt=7 mode=ws-continuous ws_chars=${deltas.join("").length} ws_pushes=2 ws_eos=1 http_chars=0 http_calls=0 aborted=0`,
    ])
    expect(ws.state.pushes.join("").length).toBe(deltas.join("").length)
    expect(lines.join("")).not.toContain(SECRET)
  })

  it("http-sentence mode: counts the chars and calls of every TTS request", async () => {
    const texts: string[] = []
    await streamTurnWithSentences(
      {
        brain: async input => {
          input.onDelta("Bonjour, comment allez-vous aujourd'hui ? ")
          input.onDelta("Je vais tres bien, merci beaucoup. ")
          return ""
        },
        tts: async ({ text }) => {
          texts.push(text)
        },
        logPrefix: "[t]",
      },
      { text: "x", utteranceId: 3, onChunk: () => undefined }
    )
    const chars = texts.reduce((n, t) => n + t.length, 0)
    expect(texts.length).toBeGreaterThan(0)
    expect(charLines()).toEqual([
      `[t] tts chars utt=3 mode=http-sentence ws_chars=0 ws_pushes=0 ws_eos=0 http_chars=${chars} http_calls=${texts.length} aborted=0`,
    ])
  })

  it("counts both sockets when the WS falls back to HTTP mid-turn", async () => {
    const ws = fakeWs({ closeBeforeAudio: true })
    const texts: string[] = []
    await streamTurnWithSentences(
      {
        brain: async input => {
          input.onDelta("Phrase un. ")
          await new Promise(r => setTimeout(r, 5))
          ws.closeNow()
          await new Promise(r => setTimeout(r, 5))
          return "Phrase un. "
        },
        tts: async ({ text }) => {
          texts.push(text)
        },
        ttsStream: ws.opener,
        logPrefix: "[t]",
      },
      { text: "x", utteranceId: 1, onChunk: () => undefined }
    )
    const line = charLines()[0]!
    expect(charLines()).toHaveLength(1)
    expect(line).toContain("ws_chars=11 ws_pushes=1 ws_eos=0")
    expect(line).toContain(
      `http_chars=${texts.reduce((n, t) => n + t.length, 0)} http_calls=${texts.length}`
    )
  })

  it("logs once with aborted=1 when the turn throws after a cut", async () => {
    const ws = fakeWs()
    const ctrl = new AbortController()
    await expect(
      streamTurnWithSentences(
        {
          brain: async input => {
            input.onDelta("Abc. ")
            await new Promise(r => setTimeout(r, 5))
            ctrl.abort()
            throw new Error("aborted")
          },
          tts: async () => undefined,
          ttsStream: ws.opener,
          logPrefix: "[t]",
        },
        {
          text: "x",
          utteranceId: 2,
          onChunk: () => undefined,
          signal: ctrl.signal,
        }
      )
    ).rejects.toThrow("aborted")
    expect(charLines()).toEqual([
      "[t] tts chars utt=2 mode=ws-continuous ws_chars=5 ws_pushes=1 ws_eos=0 http_chars=0 http_calls=0 aborted=1",
    ])
  })

  it("counts the apology spoken over HTTP when the brain fails", async () => {
    const texts: string[] = []
    await streamTurnWithSentences(
      {
        brain: async () => {
          throw new Error("boom")
        },
        tts: async ({ text }) => {
          texts.push(text)
        },
        failureText: "Désolé.",
        logPrefix: "[t]",
      },
      { text: "x", utteranceId: 4, onChunk: () => undefined }
    )
    expect(texts).toEqual(["Désolé."])
    expect(charLines()[0]).toContain("http_chars=7 http_calls=1 aborted=0")
  })
})

describe("streamTurnWithSentences: onTtsChars (per-call billing)", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {})
    vi.spyOn(console, "warn").mockImplementation(() => {})
    vi.spyOn(console, "error").mockImplementation(() => {})
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("reports once, at the end of the turn, the chars sent to TTS (same figure as the log)", async () => {
    const ws = fakeWs()
    const reported: number[] = []
    await streamTurnWithSentences(
      {
        brain: async input => {
          input.onDelta("Un. ")
          input.onDelta("Deux. ")
          return "Un. Deux. "
        },
        tts: async () => undefined,
        ttsStream: ws.opener,
        onTtsChars: n => reported.push(n),
        logPrefix: "[t]",
      },
      { text: "x", utteranceId: 3, onChunk: () => undefined }
    )
    expect(reported).toHaveLength(1)
    const wsChars = Number(/ws_chars=(\d+)/.exec(charLines()[0]!)![1])
    expect(reported[0]).toBe(wsChars)
    expect(reported[0]).toBeGreaterThan(0)
  })

  it("a throwing meter never breaks the turn", async () => {
    const ws = fakeWs()
    await expect(
      streamTurnWithSentences(
        {
          brain: async input => {
            input.onDelta("Un. ")
            return "Un. "
          },
          tts: async () => undefined,
          ttsStream: ws.opener,
          onTtsChars: () => {
            throw new Error("meter down")
          },
          logPrefix: "[t]",
        },
        { text: "x", utteranceId: 4, onChunk: () => undefined }
      )
    ).resolves.toBeDefined()
  })
})
