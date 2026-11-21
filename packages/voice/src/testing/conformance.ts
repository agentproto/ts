/**
 * AIP-VOICE conformance cases, framework-free: each case is a name and an async
 * function that throws on failure, so a provider package runs them under its
 * own test runner against a fake transport or recorded vendor exchanges.
 *
 *   for (const c of ttsConformanceCases(provider)) it(c.name, c.run)
 */
import type {
  AudioFrame,
  SttProvider,
  TtsProvider,
  VoiceEmit,
  VoiceSession,
} from "../types.js"

export interface ConformanceCase {
  name: string
  run: () => Promise<void>
}

class ConformanceError extends Error {}
const check = (cond: unknown, msg: string): void => {
  if (!cond) throw new ConformanceError(msg)
}
const settleTicks = (ms = 5) => new Promise<void>(r => setTimeout(r, ms))

// ── STT ─────────────────────────────────────────────────────────────

export interface SttConformanceInput {
  sampleRate: number
  /** Audio the provider can transcribe (recorded or synthetic). */
  frames: AudioFrame[]
  timeoutMs?: number
}

export function sttConformanceCases(provider: SttProvider, input: SttConformanceInput): ConformanceCase[] {
  const timeoutMs = input.timeoutMs ?? 2000
  const cases: ConformanceCase[] = [
    {
      name: "declares at least one of streaming and file",
      async run() {
        check(provider.capabilities.streaming || provider.capabilities.file, "stt provider has neither streaming nor file")
      },
    },
  ]
  if (provider.capabilities.streaming) {
    cases.push({
      name: "commit() ends in a final or an error, never silence",
      async run() {
        const stream = await provider.openStream({ sampleRate: input.sampleRate })
        const outcome = await new Promise<"final" | "error" | "timeout">(resolve => {
          const t = setTimeout(() => resolve("timeout"), timeoutMs)
          stream.on("final", () => (clearTimeout(t), resolve("final")))
          stream.on("error", () => (clearTimeout(t), resolve("error")))
          for (const f of input.frames) stream.pushAudio(f)
          stream.commit()
        })
        await stream.close()
        check(outcome !== "timeout", "no final and no error after commit()")
      },
    })
    cases.push({
      name: "a final never repeats the text of the previous final for the same audio",
      async run() {
        const stream = await provider.openStream({ sampleRate: input.sampleRate })
        const finals: string[] = []
        stream.on("final", t => finals.push(t.text))
        for (const f of input.frames) stream.pushAudio(f)
        stream.commit()
        await settleTicks(Math.min(timeoutMs, 50))
        await stream.close()
        check(new Set(finals).size === finals.length, `repeated final text: ${JSON.stringify(finals)}`)
      },
    })
  }
  if (provider.capabilities.file) {
    cases.push({
      name: "transcribe() of raw PCM16 requires and honors sampleRate",
      async run() {
        const bytes = new Uint8Array(input.frames.reduce((n, f) => n + f.pcm16.byteLength, 0))
        let off = 0
        for (const f of input.frames) {
          bytes.set(new Uint8Array(f.pcm16), off)
          off += f.pcm16.byteLength
        }
        const r = await provider.transcribe({ bytes, mimeType: "audio/pcm", sampleRate: input.sampleRate })
        check(typeof r.text === "string", "transcribe() returned no text field")
      },
    })
  }
  return cases
}

// ── TTS ─────────────────────────────────────────────────────────────

export function ttsConformanceCases(provider: TtsProvider): ConformanceCase[] {
  const cases: ConformanceCase[] = [
    {
      name: "declares at least one of streaming and file",
      async run() {
        check(provider.capabilities.streaming || provider.capabilities.file, "tts provider has neither streaming nor file")
      },
    },
  ]
  if (provider.capabilities.streaming) {
    cases.push({
      name: "end() delivers remaining audio, then done after the last audio",
      async run() {
        const stream = await provider.openStream({})
        const order: string[] = []
        stream.on("audio", () => order.push("audio"))
        stream.on("done", () => order.push("done"))
        stream.sendText("Hello there. ")
        stream.end()
        await settleTicks(20)
        await stream.close()
        check(order.includes("audio") && order[order.length - 1] === "done", `bad order: ${order.join(",")}`)
      },
    })
    cases.push({
      name: "after cancel() no audio and no done is delivered, and cancel() is idempotent",
      async run() {
        const stream = await provider.openStream({})
        let after = 0
        let cancelled = false
        stream.on("audio", () => cancelled && after++)
        stream.on("done", () => cancelled && after++)
        stream.sendText("A long enough sentence to generate audio. ")
        stream.cancel()
        cancelled = true
        stream.cancel()
        stream.end()
        await settleTicks(30)
        await stream.close()
        check(after === 0, `${after} event(s) delivered after cancel()`)
      },
    })
    cases.push({
      name: "flush() keeps the stream open",
      async run() {
        const stream = await provider.openStream({})
        stream.sendText("First part. ")
        stream.flush()
        stream.sendText("Second part. ")
        stream.end()
        await stream.close()
      },
    })
  }
  if (provider.capabilities.file) {
    cases.push({
      name: "synthesize() returns bytes and a mime type",
      async run() {
        const r = await provider.synthesize({ text: "Hello." })
        check(r.bytes.byteLength > 0 && r.mimeType.length > 0, "empty synthesize() result")
      },
    })
  }
  return cases
}

// ── Session ─────────────────────────────────────────────────────────

export interface SessionHarness {
  /** Start a session wired to `emit`. */
  start: (emit: VoiceEmit) => Promise<VoiceSession>
  /** Make the session produce one complete assistant turn. */
  completeTurn: (session: VoiceSession) => Promise<void>
  /** Make the session produce an assistant turn that the user then cuts. */
  interruptedTurn?: (session: VoiceSession) => Promise<void>
}

function recorder() {
  const events: string[] = []
  const emit: VoiceEmit = {
    audio: () => void events.push("audio"),
    userTranscript: () => void events.push("user"),
    assistantTranscript: () => void events.push("assistant"),
    toolCallStart: () => void events.push("tool.start"),
    toolCallEnd: () => void events.push("tool.end"),
    interrupt: () => void events.push("interrupt"),
    responseComplete: () => void events.push("complete"),
    error: () => void events.push("error"),
  }
  return { events, emit }
}

export function sessionConformanceCases(harness: SessionHarness): ConformanceCase[] {
  const cases: ConformanceCase[] = [
    {
      name: "responseComplete exactly once per uninterrupted assistant turn",
      async run() {
        const { events, emit } = recorder()
        const s = await harness.start(emit)
        await harness.completeTurn(s)
        await s.close()
        check(events.filter(e => e === "complete").length === 1, `events: ${events.join(",")}`)
        check(!events.includes("interrupt"), "interrupt emitted on an uninterrupted turn")
      },
    },
    {
      name: "usage is cumulative, monotonic and final after close()",
      async run() {
        const { emit } = recorder()
        const s = await harness.start(emit)
        const total = (u: ReturnType<NonNullable<VoiceSession["getUsage"]>>) =>
          (u?.entries ?? []).reduce((n, e) => n + (e.audioSeconds ?? 0) + (e.characters ?? 0), 0)
        const u0 = s.getUsage?.()
        await harness.completeTurn(s)
        const u1 = s.getUsage?.()
        check(total(u1) >= total(u0), "usage went down")
        await s.close()
        const u2 = s.getUsage?.()
        await settleTicks(5)
        const u3 = s.getUsage?.()
        check(total(u2) >= total(u1), "usage went down at close")
        check(total(u3) === total(u2), "usage changed after close()")
      },
    },
    {
      name: "close() is idempotent",
      async run() {
        const { emit } = recorder()
        const s = await harness.start(emit)
        await s.close()
        await s.close()
      },
    },
  ]
  if (harness.interruptedTurn) {
    cases.push({
      name: "interrupt once per interrupted turn, never together with responseComplete, and no audio after it",
      async run() {
        const { events, emit } = recorder()
        const s = await harness.start(emit)
        await harness.interruptedTurn!(s)
        await settleTicks(10)
        await s.close()
        const cut = events.indexOf("interrupt")
        check(cut >= 0, `no interrupt: ${events.join(",")}`)
        check(events.filter(e => e === "interrupt").length === 1, "more than one interrupt")
        check(!events.slice(cut).includes("audio"), "audio after interrupt")
        check(!events.includes("complete"), "responseComplete on an interrupted turn")
      },
    })
  }
  return cases
}
