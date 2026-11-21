// @ts-nocheck
// Ported from agentik-studio projects/simone/apps/voice/test/calls/stream-turn.test.ts
// The expect blocks are unchanged from the studio original; only imports (and,
// where noted in the PR, injected provider labels) differ. Type checking is off
// for this file because the studio does not type-check its test files.
import { describe, expect, it, vi } from "vitest"
import {
  streamTurnWithSentences,
  type CallTtsStreamHandle,
  type CallTtsStreamOpener,
} from "../../cascade/speak-turn.js"

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

/** Fake continuous TTS handle/opener for testing the WS-mode turn logic. */
function makeFakeTtsStream(
  opts: {
    openTimeoutMs?: number
    /** Resolve the handshake automatically after this many ms (default 0). */
    readyAfterMs?: number
    /** Reject the handshake after this many ms instead of resolving. */
    rejectAfterMs?: number
    /** Never settle the handshake (simulates a WS that hangs). */
    neverReady?: boolean
    /** Emit an audio chunk for every pushed delta (default true). */
    audioOnPush?: boolean
    /** Only the first N pushes produce audio (default: all of them). */
    audioPushes?: number
    /** end() sends EOS but the server never closes (until abort). */
    hangOnEnd?: boolean
    /** pushText throws from the Nth call on (1-based). */
    throwOnPush?: number
    /** Audio lags the text: one chunk once the Nth delta was pushed. */
    voiceAfterPushes?: number
    /** Size of each audio chunk (default 1 s of pcm_24000). */
    chunkBytes?: number
    /** end() takes this long before the server closes. */
    endDelayMs?: number
    stallTimeoutMs?: number
    drainIdleTimeoutMs?: number
  } = {}
) {
  let resolveReady!: () => void
  let rejectReady!: (e: Error) => void
  const ready = new Promise<void>((res, rej) => {
    resolveReady = res
    rejectReady = rej
  })
  ready.catch(() => undefined)
  let isReady = false
  // Pushes made before the handshake are buffered, then voiced on connect.
  const prebuffered: number[] = []
  const voice = (pushIndex: number) => {
    if (!audioOnPush || pushIndex > (opts.audioPushes ?? Infinity)) return
    if (
      opts.voiceAfterPushes !== undefined &&
      pushIndex !== opts.voiceAfterPushes
    )
      return
    state.hadAudio = true
    void onChunkRef?.(Buffer.alloc(opts.chunkBytes ?? 48_000, 1))
  }
  void ready.then(
    () => {
      isReady = true
      for (const i of prebuffered.splice(0)) voice(i)
    },
    () => undefined
  )
  let resolveClosed!: () => void
  const closed = new Promise<void>(res => {
    resolveClosed = res
  })
  const state = {
    ended: false,
    aborted: false,
    hadAudio: false,
    pushes: [] as string[],
    connects: 1,
  }
  let onChunkRef: ((c: Buffer) => void | Promise<void>) | undefined
  let onAlignmentRef:
    | ((a: {
        chars: string[]
        startTimesMs: number[]
        durationsMs: number[]
      }) => void)
    | undefined
  const audioOnPush = opts.audioOnPush ?? true
  const handle: CallTtsStreamHandle = {
    ready,
    closed,
    pushText(d: string) {
      if (state.ended || state.aborted) return
      state.pushes.push(d)
      if (
        opts.throwOnPush !== undefined &&
        state.pushes.length >= opts.throwOnPush
      )
        throw new Error("socket closing")
      // A socket that has not opened cannot produce audio.
      if (isReady) voice(state.pushes.length)
      else prebuffered.push(state.pushes.length)
    },
    async end() {
      state.ended = true
      // Like the real stream: wait out the handshake (or its failure) first.
      await ready.catch(() => undefined)
      if (opts.hangOnEnd) {
        await closed
        return
      }
      if (opts.endDelayMs !== undefined) {
        await sleep(opts.endDelayMs)
        if (state.aborted) return
        state.hadAudio = true
        void onChunkRef?.(Buffer.alloc(opts.chunkBytes ?? 48_000, 1))
      }
      resolveClosed()
    },
    abort() {
      state.aborted = true
      resolveClosed()
    },
    hadAudio: () => state.hadAudio,
    connectCount: () => state.connects,
  }
  const opener: CallTtsStreamOpener = {
    open: input => {
      onChunkRef = input.onChunk
      onAlignmentRef = input.onAlignment
      // Production opens the socket with the turn signal; mirror that so an
      // abort (barge-in / hang-up) closes the handle.
      input.signal?.addEventListener("abort", () => handle.abort(), {
        once: true,
      })
      return handle
    },
    ...(opts.openTimeoutMs !== undefined
      ? { openTimeoutMs: opts.openTimeoutMs }
      : {}),
    ...(opts.stallTimeoutMs !== undefined
      ? { stallTimeoutMs: opts.stallTimeoutMs }
      : {}),
    ...(opts.drainIdleTimeoutMs !== undefined
      ? { drainIdleTimeoutMs: opts.drainIdleTimeoutMs }
      : {}),
  }
  if (opts.neverReady) {
    // leave `ready` pending
  } else if (opts.rejectAfterMs !== undefined) {
    setTimeout(() => rejectReady(new Error("no handshake")), opts.rejectAfterMs)
  } else {
    setTimeout(() => resolveReady(), opts.readyAfterMs ?? 0)
  }
  return {
    handle,
    opener,
    state,
    closeBeforeAudio: () => resolveClosed(),
    emitAlignment: (a: {
      chars: string[]
      startTimesMs: number[]
      durationsMs: number[]
    }) => onAlignmentRef?.(a),
  }
}

const PHRASES = [
  "Bonjour, comment allez-vous aujourd'hui ? ",
  "Je vais tres bien, merci beaucoup. ",
  "Souhaitez-vous que nous parlions de votre projet ? ",
]

function delayedBrain(
  phrases: string[],
  delayMs: number,
  events: string[]
): (input: {
  text: string
  onDelta: (delta: string) => void
}) => Promise<string> {
  return async input => {
    for (const phrase of phrases) {
      input.onDelta(phrase)
      await sleep(delayMs)
    }
    events.push("brain:done")
    return phrases.join("")
  }
}

/** Like `delayedBrain`, but waits `startDelayMs` BEFORE the first delta -
 *  simulates a model that stays silent for a while before it starts
 *  streaming, which is the shape the filler timer needs to actually get a
 *  chance to fire in a test (a brain that emits its first delta
 *  synchronously, same tick, never leaves the timer time to elapse). */
function slowStartBrain(
  phrases: string[],
  startDelayMs: number,
  perPhraseDelayMs = 0
): (input: {
  text: string
  onDelta: (delta: string) => void
}) => Promise<string> {
  return async input => {
    await sleep(startDelayMs)
    for (const phrase of phrases) {
      input.onDelta(phrase)
      await sleep(perPhraseDelayMs)
    }
    return phrases.join("")
  }
}

describe("streamTurnWithSentences", () => {
  it("sends the first sentence to TTS before the brain turn completes", async () => {
    const events: string[] = []
    let brainDone = false
    const seen: string[] = []

    const reply = await streamTurnWithSentences(
      {
        brain: async input => {
          for (const phrase of PHRASES) {
            input.onDelta(phrase)
            await sleep(20)
          }
          brainDone = true
          events.push("brain:done")
          return PHRASES.join("")
        },
        tts: async ({ text, onChunk }) => {
          seen.push(text)
          events.push(`tts:${seen.length}`)
          onChunk(Buffer.from(text))
          expect(brainDone).toBe(false)
        },
      },
      { text: "raconte-moi", onChunk: () => undefined }
    )

    expect(seen).toHaveLength(3)
    expect(seen[0]!.trim()).toBe(PHRASES[0]!.trim())
    expect(events.indexOf("tts:1")).toBeLessThan(events.indexOf("brain:done"))
    expect(reply).toBe(PHRASES.join(""))
  })

  it("starts TTS before the brain ends when the reply opens with a short sentence", async () => {
    const seen: string[] = []
    let brainDone = false

    await streamTurnWithSentences(
      {
        brain: async input => {
          input.onDelta("D'accord. ")
          input.onDelta("Je regarde ton agenda de demain tout de suite. ")
          await sleep(30)
          input.onDelta("Tu as trois rendez-vous. ")
          await sleep(30)
          brainDone = true
        },
        tts: async ({ text }) => {
          seen.push(`${brainDone ? "after" : "before"}:${text}`)
        },
      },
      { text: "mon agenda", onChunk: () => undefined }
    )

    expect(seen).toEqual([
      "before:D'accord. Je regarde ton agenda de demain tout de suite.",
      "before:Tu as trois rendez-vous.",
    ])
  })

  it("keeps sentence order even when TTS duration varies", async () => {
    const seen: string[] = []
    const delays = [40, 5, 20]

    await streamTurnWithSentences(
      {
        brain: delayedBrain(PHRASES, 5, []),
        tts: async ({ text, onChunk }) => {
          seen.push(text)
          const index = seen.length - 1
          await sleep(delays[index]!)
          onChunk(Buffer.from(text))
        },
      },
      { text: "raconte-moi", onChunk: () => undefined }
    )

    expect(seen.map(s => s.trim())).toEqual(PHRASES.map(s => s.trim()))
  })

  it("speaks the returned text when the brain emitted no delta", async () => {
    const seen: string[] = []
    const reply = "La reponse complete est arrivee sans streaming."

    const full = await streamTurnWithSentences(
      {
        brain: async () => reply,
        tts: async ({ text, onChunk }) => {
          seen.push(text)
          onChunk(Buffer.from(text))
        },
      },
      { text: "bonjour", onChunk: () => undefined }
    )

    expect(seen).toEqual([reply])
    expect(full).toBe(reply)
  })

  it("does not call TTS for empty text", async () => {
    let ttsCalls = 0

    const full = await streamTurnWithSentences(
      {
        brain: async input => {
          input.onDelta("")
          return ""
        },
        tts: async () => {
          ttsCalls += 1
        },
      },
      { text: "", onChunk: () => undefined }
    )

    expect(ttsCalls).toBe(0)
    expect(full).toBe("")
  })
})

describe("streamTurnWithSentences: continuous TTS WS mode", () => {
  it("pushes the first delta to a single WS before the brain turn completes", async () => {
    const fake = makeFakeTtsStream()
    const audio: number[] = []
    let brainDone = false
    let opens = 0
    const opener: CallTtsStreamOpener = {
      ...fake.opener,
      open: input => {
        opens += 1
        return fake.opener.open(input)
      },
    }
    let httpCalls = 0
    const reply = await streamTurnWithSentences(
      {
        brain: async input => {
          for (const phrase of PHRASES) {
            input.onDelta(phrase)
            await sleep(15)
          }
          brainDone = true
          return PHRASES.join("")
        },
        tts: async () => {
          httpCalls += 1
        },
        ttsStream: opener,
      },
      {
        text: "raconte-moi",
        onChunk: c => {
          audio.push(c.length)
          expect(brainDone).toBe(false)
        },
      }
    )

    expect(opens).toBe(1)
    expect(fake.state.pushes[0]!.trim()).toBe(PHRASES[0]!.trim())
    expect(fake.state.ended).toBe(true)
    expect(fake.state.aborted).toBe(false)
    expect(httpCalls).toBe(0)
    expect(audio.length).toBeGreaterThanOrEqual(1)
    expect(reply).toBe(PHRASES.join(""))
  })

  it("aborts the WS when the turn is cut off (barge-in)", async () => {
    const fake = makeFakeTtsStream()
    const ctrl = new AbortController()
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    await expect(
      streamTurnWithSentences(
        {
          brain: async input => {
            input.onDelta(PHRASES[0]!)
            await sleep(20)
            ctrl.abort()
            throw new Error("aborted")
          },
          tts: async () => undefined,
          failureText: "Désolé.",
          ttsStream: fake.opener,
        },
        { text: "x", onChunk: () => undefined, signal: ctrl.signal }
      )
    ).rejects.toThrow("aborted")
    errSpy.mockRestore()
    expect(fake.state.aborted).toBe(true)
    expect(fake.state.ended).toBe(false)
  })

  it("falls back to per-sentence HTTP when the WS never opens in time", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    const fake = makeFakeTtsStream({ openTimeoutMs: 10, neverReady: true })
    const spoken: string[] = []
    const reply = await streamTurnWithSentences(
      {
        brain: async input => {
          for (const phrase of PHRASES) {
            input.onDelta(phrase)
            await sleep(12)
          }
          return PHRASES.join("")
        },
        tts: async ({ text }) => {
          spoken.push(text)
        },
        ttsStream: fake.opener,
      },
      { text: "x", onChunk: () => undefined }
    )
    errorSpy.mockRestore()
    expect(fake.state.aborted).toBe(true)
    expect(spoken.join(" ")).toContain("Bonjour")
    expect(reply).toBe(PHRASES.join(""))
  })

  it("falls back when the WS closes before any audio", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    const fake = makeFakeTtsStream({ audioOnPush: false })
    const spoken: string[] = []
    // Close the socket right after the first delta is queued.
    const opener: CallTtsStreamOpener = {
      ...fake.opener,
      open: input => {
        const h = fake.opener.open(input)
        setTimeout(() => fake.closeBeforeAudio(), 5)
        return h
      },
    }
    await streamTurnWithSentences(
      {
        brain: async input => {
          input.onDelta(PHRASES[0]!)
          await sleep(15)
          input.onDelta(PHRASES[1]!)
          return PHRASES[0]! + PHRASES[1]!
        },
        tts: async ({ text }) => {
          spoken.push(text)
        },
        ttsStream: opener,
      },
      { text: "x", onChunk: () => undefined }
    )
    errorSpy.mockRestore()
    // The whole accumulated text was replayed through the HTTP path.
    expect(spoken.join(" ")).toContain("Bonjour")
    expect(spoken.join(" ")).toContain("vais tres bien")
  })






  it("keeps the per-sentence HTTP path when no ttsStream is configured", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {})
    const spoken: string[] = []
    await streamTurnWithSentences(
      {
        brain: async input => {
          for (const phrase of PHRASES) input.onDelta(phrase)
          return PHRASES.join("")
        },
        tts: async ({ text, onChunk }) => {
          spoken.push(text)
          await onChunk(Buffer.alloc(2))
        },
      },
      { text: "x", onChunk: () => undefined }
    )
    const lines = log.mock.calls.map(c => String(c[0]))
    log.mockRestore()
    expect(spoken.join(" ")).toContain("Bonjour")
    expect(lines.some(l => l.includes("mode=http-sentence"))).toBe(true)
    expect(lines.some(l => l.includes("ws-continuous"))).toBe(false)
  })
})

describe("streamTurnWithSentences: continuous TTS WS fallback", () => {
  const quiet = () => {
    const spies = [
      vi.spyOn(console, "log").mockImplementation(() => {}),
      vi.spyOn(console, "warn").mockImplementation(() => {}),
      vi.spyOn(console, "error").mockImplementation(() => {}),
    ]
    return () => spies.forEach(s => s.mockRestore())
  }
  const recorder = () => {
    const spoken: string[] = []
    return {
      spoken,
      tts: async ({ text }: { text: string }) => {
        spoken.push(text)
      },
    }
  }

  it("speaks the turn over HTTP when the WS never opens and the brain ends before openTimeoutMs", async () => {
    const restore = quiet()
    // Handshake fails 40 ms in; the brain is done long before the 1500 ms
    // open timeout and the turn-level timer cannot help.
    const fake = makeFakeTtsStream({ rejectAfterMs: 40, openTimeoutMs: 1500 })
    const rec = recorder()
    const reply = await streamTurnWithSentences(
      {
        brain: async input => {
          input.onDelta(PHRASES[0]!)
          input.onDelta(PHRASES[1]!)
          return PHRASES[0]! + PHRASES[1]!
        },
        tts: rec.tts,
        ttsStream: fake.opener,
      },
      { text: "x", onChunk: () => undefined }
    )
    restore()
    expect(fake.state.aborted).toBe(true)
    expect(rec.spoken.join(" ")).toContain("Bonjour")
    expect(rec.spoken.join(" ")).toContain("vais tres bien")
    expect(reply).toBe(PHRASES[0]! + PHRASES[1]!)
  })

  it("speaks the apology over HTTP when the brain fails and the WS never opened", async () => {
    const restore = quiet()
    const fake = makeFakeTtsStream({ rejectAfterMs: 30 })
    const rec = recorder()
    await streamTurnWithSentences(
      {
        brain: async () => {
          throw new Error("brain down")
        },
        tts: rec.tts,
        failureText: "Désolé, souci technique.",
        ttsStream: fake.opener,
      },
      { text: "x", onChunk: () => undefined }
    )
    restore()
    expect(rec.spoken).toEqual(["Désolé, souci technique."])
  })

  it("falls back when the WS stays open but mute with enough text waiting", async () => {
    const restore = quiet()
    const fake = makeFakeTtsStream({ audioOnPush: false, stallTimeoutMs: 30 })
    const rec = recorder()
    const long = "Une longue phrase sans fin. ".repeat(5)
    const reply = await streamTurnWithSentences(
      {
        brain: async input => {
          input.onDelta(long)
          await sleep(120)
          input.onDelta("Et la suite. ")
          return long + "Et la suite. "
        },
        tts: rec.tts,
        ttsStream: fake.opener,
      },
      { text: "x", onChunk: () => undefined }
    )
    restore()
    expect(fake.state.aborted).toBe(true)
    const said = rec.spoken.join(" ")
    // Whole text replayed once, then the later delta through HTTP, not the WS.
    expect(said.match(/Une longue phrase sans fin\./g)).toHaveLength(5)
    expect(said).toContain("Et la suite.")
    expect(fake.state.pushes).toEqual([long])
    expect(reply).toBe(long + "Et la suite. ")
  })

  it("falls back mid-turn after audio without repeating what was already voiced", async () => {
    const restore = quiet()
    // Only the first delta is voiced; then the socket drops.
    const fake = makeFakeTtsStream({ audioPushes: 1 })
    const rec = recorder()
    const audio: number[] = []
    await streamTurnWithSentences(
      {
        brain: async input => {
          input.onDelta("Phrase un. ")
          await sleep(10)
          input.onDelta("Phrase deux. ")
          await sleep(10)
          fake.closeBeforeAudio()
          await sleep(10)
          input.onDelta("Phrase trois. ")
          return "Phrase un. Phrase deux. Phrase trois. "
        },
        tts: rec.tts,
        ttsStream: fake.opener,
      },
      { text: "x", onChunk: c => void audio.push(c.length) }
    )
    restore()
    expect(audio.length).toBe(1)
    const said = rec.spoken.join(" ")
    expect(said).not.toContain("Phrase un.")
    expect(said).toContain("Phrase deux.")
    expect(said).toContain("Phrase trois.")
    // Later deltas never reached the dead socket.
    expect(fake.state.pushes).toEqual(["Phrase un. ", "Phrase deux. "])
  })

  it("replays text the audio had not reached when the audio lagged several pushed sentences", async () => {
    const restore = quiet()
    // Audio only starts after the third delta and covers about half a second
    // of speech, so most of the pushed text was never voiced when the socket
    // drops.
    const fake = makeFakeTtsStream({ voiceAfterPushes: 3, chunkBytes: 24_000 })
    const rec = recorder()
    await streamTurnWithSentences(
      {
        brain: async input => {
          input.onDelta("Phrase un. ")
          await sleep(10)
          input.onDelta("Phrase deux. ")
          await sleep(10)
          input.onDelta("Phrase trois. ")
          await sleep(10)
          fake.closeBeforeAudio()
          await sleep(10)
          input.onDelta("Phrase quatre. ")
          return "Phrase un. Phrase deux. Phrase trois. Phrase quatre. "
        },
        tts: rec.tts,
        ttsStream: fake.opener,
      },
      { text: "x", onChunk: () => undefined }
    )
    restore()
    const said = rec.spoken.join(" ")
    expect(said).toContain("Phrase deux.")
    expect(said).toContain("Phrase trois.")
    expect(said).toContain("Phrase quatre.")
  })


  it("falls back when the server never closes after EOS (bounded drain)", async () => {
    const restore = quiet()
    const fake = makeFakeTtsStream({
      audioPushes: 1,
      hangOnEnd: true,
      drainIdleTimeoutMs: 40,
    })
    const rec = recorder()
    const started = Date.now()
    await streamTurnWithSentences(
      {
        brain: async input => {
          input.onDelta("Phrase un. ")
          await sleep(15)
          input.onDelta("Phrase deux. ")
          return "Phrase un. Phrase deux. "
        },
        tts: rec.tts,
        ttsStream: fake.opener,
      },
      { text: "x", onChunk: () => undefined }
    )
    restore()
    expect(Date.now() - started).toBeLessThan(1000)
    expect(fake.state.aborted).toBe(true)
    const said = rec.spoken.join(" ")
    expect(said).not.toContain("Phrase un.")
    expect(said).toContain("Phrase deux.")
  })

  it("falls back when the WS closes cleanly without ever producing audio", async () => {
    const restore = quiet()
    const fake = makeFakeTtsStream({ audioOnPush: false })
    const rec = recorder()
    await streamTurnWithSentences(
      {
        brain: async input => {
          input.onDelta("Bonjour tout le monde. ")
          return "Bonjour tout le monde. "
        },
        tts: rec.tts,
        ttsStream: fake.opener,
      },
      { text: "x", onChunk: () => undefined }
    )
    restore()
    expect(rec.spoken.join(" ")).toContain("Bonjour tout le monde.")
  })

  it("survives a pushText that throws and replays the text over HTTP", async () => {
    const restore = quiet()
    const fake = makeFakeTtsStream({ audioOnPush: false, throwOnPush: 2 })
    const rec = recorder()
    const reply = await streamTurnWithSentences(
      {
        brain: async input => {
          input.onDelta("Premiere phrase. ")
          await sleep(10)
          input.onDelta("Deuxieme phrase. ")
          await sleep(10)
          input.onDelta("Troisieme phrase. ")
          return "Premiere phrase. Deuxieme phrase. Troisieme phrase. "
        },
        tts: rec.tts,
        ttsStream: fake.opener,
      },
      { text: "x", onChunk: () => undefined }
    )
    restore()
    const said = rec.spoken.join(" ")
    expect(said).toContain("Premiere phrase.")
    expect(said).toContain("Deuxieme phrase.")
    expect(said).toContain("Troisieme phrase.")
    expect(reply).toContain("Troisieme phrase.")
  })

  it("keeps a healthy WS turn untouched by the watchdogs", async () => {
    const restore = quiet()
    const fake = makeFakeTtsStream({
      stallTimeoutMs: 20,
      drainIdleTimeoutMs: 20,
    })
    const rec = recorder()
    await streamTurnWithSentences(
      {
        brain: async input => {
          for (const phrase of PHRASES) {
            input.onDelta(phrase)
            await sleep(10)
          }
          return PHRASES.join("")
        },
        tts: rec.tts,
        ttsStream: fake.opener,
      },
      { text: "x", onChunk: () => undefined }
    )
    restore()
    expect(fake.state.aborted).toBe(false)
    expect(rec.spoken).toEqual([])
  })
})

type BrainInput = {
  text: string
  onDelta: (delta: string) => void
  onToolStart?: (toolName: string | undefined) => void
}

/** Starts a tool right away, stays silent for `startDelayMs`, then streams. */
function toolBrain(
  toolNames: Array<string | undefined>,
  startDelayMs: number,
  phrases: string[] = ["Voila ma reponse complete. "]
): (input: BrainInput) => Promise<string> {
  return async input => {
    for (const name of toolNames) input.onToolStart?.(name)
    await sleep(startDelayMs)
    for (const phrase of phrases) input.onDelta(phrase)
    return phrases.join("")
  }
}





describe("streamTurnWithSentences brain failure", () => {

  it("plays already-streamed text before the apology", async () => {
    const spoken: string[] = []
    await streamTurnWithSentences(
      {
        brain: async input => {
          input.onDelta("Alors je commence à regarder ceci. ")
          throw new Error("idle")
        },
        tts: async ({ text }) => {
          spoken.push(text)
        },
        failureText: "Désolé.",
      },
      { text: "salut", onChunk: () => undefined }
    )
    expect(spoken.at(-1)).toBe("Désolé.")
    expect(spoken.join(" ")).toContain("Alors je commence")
  })

  it("apologises when the brain completes with no text at all (api deferred the turn)", async () => {
    const spoken: string[] = []
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    const out = await streamTurnWithSentences(
      {
        brain: async () => "",
        tts: async ({ text }) => {
          spoken.push(text)
        },
        failureText: "Désolé.",
      },
      { text: "salut", onChunk: () => undefined }
    )
    errSpy.mockRestore()
    expect(spoken).toEqual(["Désolé."])
    expect(out).toBe("Désolé.")
  })

  it("stays silent on an empty reply when the turn was abandoned", async () => {
    const ctrl = new AbortController()
    ctrl.abort()
    const spoken: string[] = []
    await streamTurnWithSentences(
      {
        brain: async () => undefined,
        tts: async ({ text }) => {
          spoken.push(text)
        },
        failureText: "Désolé.",
      },
      { text: "salut", onChunk: () => undefined, signal: ctrl.signal }
    )
    expect(spoken).toEqual([])
  })

  it("rethrows when no failureText is configured", async () => {
    await expect(
      streamTurnWithSentences(
        {
          brain: async () => {
            throw new Error("boom")
          },
          tts: async () => undefined,
        },
        { text: "salut", onChunk: () => undefined }
      )
    ).rejects.toThrow("boom")
  })

  it("does not reject when the apology tts itself fails", async () => {
    const out = await streamTurnWithSentences(
      {
        brain: async () => {
          throw new Error("boom")
        },
        tts: async () => {
          throw new Error("tts down")
        },
        failureText: "Désolé.",
      },
      { text: "salut", onChunk: () => undefined }
    )
    expect(out).toBe("Désolé.")
  })

  it("logs the first-chunk latency of each sentence, without its text", async () => {
    const logs: string[] = []
    const logSpy = vi.spyOn(console, "log").mockImplementation((...a) => {
      logs.push(a.map(String).join(" "))
    })
    await streamTurnWithSentences(
      {
        brain: async input => {
          input.onDelta(PHRASES[0]!)
          input.onDelta(PHRASES[1]!)
        },
        tts: async ({ onChunk }) => {
          await sleep(15)
          await onChunk(Buffer.alloc(4))
          await onChunk(Buffer.alloc(4))
        },
        logPrefix: "[t]",
      },
      { text: "salut", utteranceId: 7, onChunk: () => undefined }
    )
    logSpy.mockRestore()
    const ttfb = logs.filter(l => l.includes("tts first chunk"))
    expect(ttfb).toHaveLength(2)
    expect(ttfb[0]).toMatch(/utt=7 sentence=1 ttfb_ms=\d+ chars=\d+/)
    expect(ttfb[1]).toMatch(/utt=7 sentence=2 /)
    expect(ttfb.join("")).not.toContain("Bonjour")
  })

  it("awaits onChunk so a slow consumer holds the TTS writer", async () => {
    const order: string[] = []
    let release!: () => void
    const gate = new Promise<void>(r => (release = r))
    const p = streamTurnWithSentences(
      {
        brain: async input => {
          input.onDelta(PHRASES[0]!)
        },
        tts: async ({ onChunk }) => {
          await onChunk(Buffer.alloc(2))
          order.push("after-chunk-1")
          await onChunk(Buffer.alloc(2))
          order.push("after-chunk-2")
        },
      },
      {
        text: "salut",
        onChunk: async () => {
          order.push("chunk")
          if (order.length === 1) await gate
        },
      }
    )
    await sleep(30)
    expect(order).toEqual(["chunk"])
    release()
    await p
    expect(order).toEqual(["chunk", "after-chunk-1", "chunk", "after-chunk-2"])
  })

  it("does not log 'onSentence failed' when the TTS is aborted by a cut-off turn", async () => {
    const ctrl = new AbortController()
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    await streamTurnWithSentences(
      {
        brain: async input => {
          input.onDelta(PHRASES[0]!)
          await sleep(10)
        },
        tts: async () => {
          ctrl.abort()
          const err = new Error("This operation was aborted")
          err.name = "AbortError"
          throw err
        },
      },
      { text: "salut", onChunk: () => undefined, signal: ctrl.signal }
    )
    const logged = errSpy.mock.calls.map(c => String(c[0]))
    errSpy.mockRestore()
    expect(logged.filter(l => l.includes("onSentence failed"))).toEqual([])
  })
})

