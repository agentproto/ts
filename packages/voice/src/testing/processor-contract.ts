/**
 * Processor contract suite (AIP-75, Processors): the cases an engine that runs
 * processors MUST pass, framework-free like the provider conformance cases.
 *
 *   import { runProcessorContractSuite } from "@agentproto/voice/testing"
 *   runProcessorContractSuite({ name: "my engine", makeSession })
 *
 * The suite drives the active point (`textOut`) and the observers; reserved
 * points are not exercised. A host (a product overlay, another engine) supplies
 * `makeSession`, which starts a cascade session on fake providers with the
 * given processors; `makeReferenceProcessorSession` is the kit's own.
 */
import { startCascade } from "../cascade/start-cascade.js"
import {
  ProcessorConfigError,
  defineObserver,
  defineTransformer,
  type BrainEvent,
  type ProcessorEvent,
  type ProcessorStats,
  type VoiceProcessors,
} from "../processors.js"
import type { VoiceSession, VoiceUsage } from "../types.js"
import type { ConformanceCase } from "./conformance.js"
import { makeFakeStt, makeFakeTts, pcmFrame } from "./fakes.js"

export interface ProcessorSessionOptions {
  /** The brain's reply for the turn. Default: one sentence. */
  brain?: (input: { signal: AbortSignal }) => AsyncIterable<string | BrainEvent>
  brainGuards?: { firstChunkMs?: number; idleMs?: number }
}

export interface ProcessorTestSession {
  /** Commit one user utterance; resolves once the turn has started. */
  start(): Promise<void>
  /** Resolves when the turn ended (completed or interrupted). */
  ended(): Promise<void>
  /** Cut the assistant turn now. */
  bargeIn(): Promise<void>
  close(): Promise<void>
  /** Everything the host saw, in order. */
  readonly events: Array<{ type: string; text?: string; seq?: number }>
  readonly processorEvents: ProcessorEvent[]
  /** Text the TTS provider received, in order. */
  readonly tts: string[]
  usage(): VoiceUsage | undefined
  stats(): Record<string, ProcessorStats> | undefined
}

export type MakeProcessorSession = (
  processors: VoiceProcessors,
  opts?: ProcessorSessionOptions,
) => Promise<ProcessorTestSession>

async function* oneSentence() {
  yield "Hello there. "
}

/** The kit's own session factory: cascade on fake providers, manual commit. */
export const makeReferenceProcessorSession: MakeProcessorSession = async (processors, opts = {}) => {
  const events: ProcessorTestSession["events"] = []
  const processorEvents: ProcessorEvent[] = []
  let resolveEnded!: () => void
  const endedP = new Promise<void>(r => (resolveEnded = r))
  const tts = makeFakeTts()
  const log = console.log
  console.log = () => undefined
  const session: VoiceSession = await startCascade({
    emit: {
      audio: f => events.push({ type: "audio", seq: f.sequenceNumber }),
      userTranscript: (t, f) => events.push({ type: "user", text: `${t}:${f}` }),
      assistantTranscript: t => events.push({ type: "assistant", text: t }),
      toolCallStart: () => undefined,
      toolCallEnd: () => undefined,
      interrupt: () => {
        events.push({ type: "interrupt" })
        resolveEnded()
      },
      responseComplete: () => {
        events.push({ type: "complete" })
        resolveEnded()
      },
      error: e => events.push({ type: "error", text: e.message }),
    },
    hooks: { onProcessorEvent: e => void processorEvents.push(e) },
    processors,
    stt: makeFakeStt({ finals: ["hello"] }),
    tts,
    vad: false,
    idleMicMs: 0,
    ...(opts.brainGuards ? { brainGuards: opts.brainGuards } : {}),
    brain: ({ signal }) => (opts.brain ? opts.brain({ signal }) : oneSentence()),
  }).finally(() => {
    console.log = log
  })
  return {
    async start() {
      await session.pushAudio(pcmFrame(200, 16_000))
      void session.commit()
    },
    ended: () => endedP,
    bargeIn: () => session.interrupt(),
    close: () => session.close(),
    events,
    processorEvents,
    get tts() {
      return tts.streams.flatMap(s => s.texts).concat(tts.synthesized)
    },
    usage: () => session.getUsage?.(),
    stats: () => session.getProcessorStats?.(),
  }
}

class ContractError extends Error {}
const check = (cond: unknown, msg: string): void => {
  if (!cond) throw new ContractError(msg)
}
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))
async function until(pred: () => boolean, ms = 2000, what = "condition"): Promise<void> {
  const t0 = Date.now()
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new ContractError(`timed out waiting for ${what}`)
    await sleep(5)
  }
}
const withTimeout = async <T>(p: Promise<T>, ms: number, what: string): Promise<T> => {
  let t: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, rej) => (t = setTimeout(() => rej(new ContractError(`timed out: ${what}`)), ms))),
    ])
  } finally {
    clearTimeout(t)
  }
}
async function* chunks(...parts: Array<string | BrainEvent | number>): AsyncGenerator<string | BrainEvent> {
  for (const p of parts) {
    if (typeof p === "number") await sleep(p)
    else yield p
  }
}

/** Run one turn to its end and return the session (closed by the caller). */
async function turn(make: MakeProcessorSession, processors: VoiceProcessors, opts?: ProcessorSessionOptions) {
  const s = await make(processors, opts)
  await s.start()
  await withTimeout(s.ended(), 4000, "the turn to end")
  return s
}

const configError = async (make: MakeProcessorSession, processors: VoiceProcessors) => {
  try {
    const s = await make(processors)
    await s.close()
  } catch (err) {
    check(err instanceof Error, "a mount error must be an Error")
    return err as Error & { code?: string; names?: string[] }
  }
  throw new ContractError("the session started although the processors are invalid")
}

const text = (name: string, fn: (t: string) => string, extra: Partial<{ modifies: string[]; budgetMs: number }> = {}) =>
  defineTransformer({
    name,
    hook: "textOut",
    modifies: extra.modifies ?? ["text"],
    ...(extra.budgetMs !== undefined ? { budgetMs: extra.budgetMs } : {}),
    run: c => ({ ...c, text: c.text ? fn(c.text) : c.text }),
  })

export function processorContractCases(make: MakeProcessorSession): ConformanceCase[] {
  return [
    {
      name: "1. a missing or duplicated name is rejected at mount, before any session",
      async run() {
        const noName = { kind: "observer", name: "", hook: "textOut", observe() {} } as never
        const e1 = await configError(make, [noName])
        check(e1.message.length > 0, "empty message")
        const a = text("same", t => t)
        const b = defineTransformer({ name: "same", hook: "textOut", modifies: ["other"], run: c => c })
        const e2 = await configError(make, [a, b])
        check(e2.message.includes("same"), "the message must name the processor")
      },
    },
    {
      name: "2. the array order is the execution order",
      async run() {
        const s = await turn(make, [
          text("first", t => `1${t}`, { modifies: ["text:a"] }),
          text("second", t => `2${t}`, { modifies: ["text:b"] }),
        ])
        check(s.tts.join("").includes("21Hello"), `expected "21Hello" in TTS, got ${JSON.stringify(s.tts)}`)
        await s.close()
      },
    },
    {
      name: "3. a shared facet needs an explicit after in the right order; bad after and empty modifies are rejected",
      async run() {
        const early = text("early", t => t)
        const lateNoAfter = text("late", t => t)
        const e = await configError(make, [early, lateNoAfter])
        check(e.message.includes("early") && e.message.includes("late") && e.message.includes("text"), "conflict must name both and the facet")
        const lateOk = defineTransformer({ name: "late", hook: "textOut", modifies: ["text"], after: ["early"], run: c => c })
        await (await make([early, lateOk])).close()
        const wrongOrder = await configError(make, [lateOk, early])
        check(wrongOrder.message.includes("early"), "after pointing to a later processor must be rejected")
        const missing = defineTransformer({ name: "m", hook: "textOut", modifies: ["z"], after: ["nope"], run: c => c })
        await configError(make, [missing])
        const obs = defineObserver({ name: "o", hook: "textOut", observe() {} })
        const toObs = defineTransformer({ name: "t", hook: "textOut", modifies: ["z"], after: ["o"], run: c => c })
        await configError(make, [obs, toObs])
        const empty = { kind: "transformer", name: "e", hook: "textOut", modifies: [], run: (c: unknown) => c } as never
        await configError(make, [empty])
        const neg = { kind: "transformer", name: "n", hook: "textOut", modifies: ["z"], budgetMs: -1, run: (c: unknown) => c } as never
        await configError(make, [neg])
      },
    },
    {
      name: "4. splitting, dropping, and output order with a slow transformer",
      async run() {
        const reply = () => chunks("one. ", "two. ", "three. ")
        const slow = defineTransformer({
          name: "slow-first",
          hook: "textOut",
          modifies: ["text"],
          budgetMs: 0,
          async run(c) {
            if (c.text.startsWith("one")) await sleep(60)
            return c
          },
        })
        const s1 = await turn(make, [slow], { brain: reply })
        const joined = s1.tts.join("|")
        check(joined.indexOf("one") < joined.indexOf("two") && joined.indexOf("two") < joined.indexOf("three"), `order lost: ${joined}`)
        await s1.close()
        const drop = defineTransformer({ name: "drop-two", hook: "textOut", modifies: ["text"], run: c => (c.text.startsWith("two") ? null : c) })
        const s2 = await turn(make, [drop], { brain: reply })
        check(!s2.tts.join("").includes("two"), "a null result must remove the item")
        await s2.close()
        const split = defineTransformer({
          name: "split",
          hook: "textOut",
          modifies: ["text"],
          run: c => (c.text.startsWith("one") ? [{ text: "uno. " }, { text: "eins. " }] : c),
        })
        const s3 = await turn(make, [split], { brain: reply })
        const j3 = s3.tts.join("|")
        check(j3.includes("uno") && j3.includes("eins") && j3.indexOf("uno") < j3.indexOf("eins"), `split lost: ${j3}`)
        await s3.close()
      },
    },
    {
      name: "5. fail-open: a throw, a rejection or an invalid output lets the input through and the session lives",
      async run() {
        const bad: Array<[string, (c: never) => unknown]> = [
          ["throws", () => { throw new Error("boom") }],
          ["rejects", async () => { throw new Error("boom") }],
          ["invalid", () => ({ text: 42 })],
        ]
        for (const [label, run] of bad) {
          const t = defineTransformer({ name: `bad-${label}`, hook: "textOut", modifies: ["text"], run: run as never })
          const s = await turn(make, [t])
          check(s.tts.join("").includes("Hello there"), `${label}: the input must go through`)
          check(s.processorEvents.some(e => e.type === "error" && e.name === `bad-${label}`), `${label}: an error event is expected`)
          check(s.events.some(e => e.type === "complete"), `${label}: the turn must complete`)
          await s.close()
        }
      },
    },
    {
      name: "6. an overrun is measured, reported, and leaves the input unchanged",
      async run() {
        const slow = defineTransformer({
          name: "too-slow",
          hook: "textOut",
          modifies: ["text"],
          budgetMs: 30,
          async run(c) {
            await sleep(150)
            return { ...c, text: "LATE" }
          },
        })
        const s = await turn(make, [slow])
        const e = s.processorEvents.find(x => x.type === "budget-exceeded")
        check(e, "budget-exceeded expected")
        check((e!.elapsedMs ?? 0) >= 30 && e!.budgetMs === 30, `elapsed ${e!.elapsedMs} vs budget ${e!.budgetMs}`)
        await sleep(200)
        check(!s.tts.join("").includes("LATE"), "a late result must be ignored")
        check(s.tts.join("").includes("Hello there"), "the input must continue unchanged")
        const st = s.stats()?.["too-slow"]
        check(st && st.overruns >= 1 && st.maxMs >= 30, "stats must record the overrun")
        await s.close()
      },
    },
    {
      name: "7. five overruns in a row bypass the transformer once",
      async run() {
        const slow = defineTransformer({
          name: "always-slow",
          hook: "textOut",
          modifies: ["text"],
          budgetMs: 5,
          async run(c) {
            await sleep(30)
            return c
          },
        })
        const s = await turn(make, [slow], { brain: () => chunks("a. ", "b. ", "c. ", "d. ", "e. ", "f. ", "g. ") })
        const n = s.processorEvents.filter(e => e.type === "bypassed" && e.name === "always-slow").length
        check(n === 1, `bypassed expected exactly once, got ${n}`)
        await s.close()
      },
    },
    {
      name: "8. observers never block, are bounded, read-only, and can publish",
      async run() {
        const never = defineObserver({ name: "never-ends", hook: "textOut", observe: () => new Promise<void>(() => undefined) })
        const s1 = await turn(make, [never])
        check(s1.events.some(e => e.type === "complete"), "a stuck observer must not block the turn")
        await s1.close()

        const bounded = defineObserver({ name: "bounded", hook: "textOut", queueMax: 2, observe: () => new Promise<void>(() => undefined) })
        const s2 = await turn(make, [bounded], { brain: () => chunks("a. ", "b. ", "c. ", "d. ", "e. ") })
        await until(() => s2.processorEvents.some(e => e.type === "dropped"), 1000, "a dropped event")
        const d = s2.processorEvents.find(e => e.type === "dropped")!
        check(typeof d.data?.count === "number" && (d.data.count as number) >= 1, "dropped must carry a count")
        await s2.close()

        const broken = defineObserver({ name: "broken", hook: "textOut", observe() { throw new Error("obs down") } })
        const mutator = defineObserver({
          name: "mutator",
          hook: "textOut",
          observe(item) {
            try {
              ;(item as { text: string }).text = "MUTATED"
            } catch {
              // a frozen item refuses; either way the path is untouched
            }
          },
        })
        const pub = defineObserver({ name: "pub", hook: "textOut", observe: (_i, ctx) => ctx.publish({ n: 1 }) })
        const s3 = await turn(make, [broken, mutator, pub])
        await until(() => s3.processorEvents.some(e => e.type === "published"), 1000, "a published event")
        check(s3.processorEvents.some(e => e.type === "error" && e.name === "broken"), "an observer failure is an event")
        check(!s3.tts.join("").includes("MUTATED"), "an observer must not change the path")
        await s3.close()
      },
    },
    {
      name: "9. barge-in aborts the signal of every processor, and a deaf one is abandoned without blocking",
      async run() {
        // (a) a transformer that honours the signal sees it aborted
        let transformerAborted = false
        const watch = defineTransformer({
          name: "watch",
          hook: "textOut",
          modifies: ["text"],
          budgetMs: 0,
          run: (c, ctx) =>
            new Promise(resolve => {
              ctx.signal.addEventListener("abort", () => {
                transformerAborted = true
                resolve(c)
              })
            }),
        })
        const a = await make([watch], { brain: () => chunks("Hello there. ", 1500) })
        await a.start()
        await sleep(100)
        await a.bargeIn()
        await withTimeout(a.ended(), 1000, "interrupt to be emitted")
        await sleep(50)
        check(transformerAborted, "the transformer signal must be aborted at barge-in")
        const mark = a.events.length
        await sleep(200)
        check(a.events.slice(mark).every(e => e.type !== "audio"), "no audio after interrupt")
        await withTimeout(a.close(), 500, "close")

        // (b) an observer sees its signal aborted
        let observerSignal: AbortSignal | undefined
        const obs = defineObserver({
          name: "watch-obs",
          hook: "textOut",
          observe(_i, ctx) {
            observerSignal = ctx.signal
          },
        })
        const b = await make([obs], { brain: () => chunks("Hello there. ", 1500) })
        await b.start()
        await sleep(100)
        await b.bargeIn()
        await withTimeout(b.ended(), 1000, "interrupt to be emitted")
        check(observerSignal?.aborted === true, "the observer signal must be aborted at barge-in")
        await b.close()

        // (c) a processor that ignores the signal is abandoned; nothing waits for it
        const deaf = defineTransformer({
          name: "deaf",
          hook: "textOut",
          modifies: ["deaf"],
          budgetMs: 0,
          run: () => new Promise<never>(() => undefined),
        })
        const c = await make([deaf], { brain: () => chunks("Hello there. ", 1500) })
        await c.start()
        await sleep(100)
        const t0 = Date.now()
        await c.bargeIn()
        await withTimeout(c.ended(), 1000, "interrupt to be emitted")
        check(Date.now() - t0 < 500, "interrupt must not wait for a deaf processor")
        await until(() => c.processorEvents.some(e => e.type === "abandoned" && e.name === "deaf"), 1000, "an abandoned event")
        await withTimeout(c.close(), 500, "close")
      },
    },
    {
      name: "10. a turn whose text is entirely dropped still completes once",
      async run() {
        const eat = defineTransformer({ name: "eat", hook: "textOut", modifies: ["text"], run: () => null })
        const s = await turn(make, [eat])
        await sleep(30)
        check(s.events.filter(e => e.type === "complete").length === 1, "exactly one responseComplete")
        await s.close()
      },
    },
    {
      name: "11. the transcript keeps the brain text; TTS and usage follow the processed text",
      async run() {
        const t = text("numbers", x => x.replace("12", "twelve"))
        const s = await turn(make, [t], { brain: () => chunks("It costs 12. ") })
        const assistant = s.events.find(e => e.type === "assistant")?.text ?? ""
        check(assistant.includes("12") && !assistant.includes("twelve"), `the transcript must be unprocessed, got ${JSON.stringify(assistant)}`)
        const spoken = s.tts.join("")
        check(spoken.includes("twelve"), "the TTS must get the processed text")
        const chars = s.usage()?.entries.find(e => e.stage === "tts")?.characters
        check(chars === spoken.length, `usage must count the processed text (${chars} vs ${spoken.length})`)
        await s.close()
      },
    },
    {
      name: "12. a brain activity event resets the guards, with or without processors",
      async run() {
        const brain = () => chunks("Hi. ", 120, { type: "activity" }, 120, "bye. ")
        for (const processors of [[], [defineObserver({ name: "o", hook: "textOut", observe() {} })]] as VoiceProcessors[]) {
          const s = await turn(make, processors, { brain, brainGuards: { firstChunkMs: 1000, idleMs: 200 } })
          check(s.tts.join("").includes("bye"), "the guard must not cut a brain that signalled activity")
          check(!s.events.some(e => e.type === "error"), "no error expected")
          await s.close()
        }
      },
    },
    {
      name: "13. sequence numbers are strictly increasing on audio",
      async run() {
        const split = defineTransformer({ name: "dup", hook: "textOut", modifies: ["text"], run: c => [c, { text: "again. " }] })
        const s = await turn(make, [split], { brain: () => chunks("a. ", "b. ") })
        const seqs = s.events.filter(e => e.type === "audio").map(e => e.seq as number)
        check(seqs.length > 0, "audio expected")
        for (let i = 1; i < seqs.length; i++) check(seqs[i]! > seqs[i - 1]!, `not increasing at ${i}: ${seqs.join(",")}`)
        await s.close()
      },
    },
  ]
}

export interface ProcessorContractSuiteOptions {
  name: string
  makeSession: MakeProcessorSession
}

/** Register the suite under the caller's vitest. */
export async function runProcessorContractSuite(opts: ProcessorContractSuiteOptions): Promise<void> {
  const { describe, it } = (await import("vitest")) as typeof import("vitest")
  describe(`processor contract: ${opts.name}`, () => {
    for (const c of processorContractCases(opts.makeSession)) it(c.name, c.run, 15_000)
  })
}

export { ProcessorConfigError }
