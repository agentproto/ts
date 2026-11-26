/**
 * Processor pipeline (AIP-75, Processors): composable units that sit on the
 * path of a cascade session at four named points.
 *
 *   transformer  on the path, streaming per item, measured time budget,
 *                fail-open (the input item goes on unchanged) on overrun or
 *                failure;
 *   observer     off the path, never awaited, read-only, bounded queue,
 *                publishes events only.
 *
 * The cascade engine runs `textOut` today. `transcript`, `audioIn` and
 * `audioOut` are reserved points: a processor may be declared there (it is
 * validated at mount) and the runtime below runs them, but the cascade engine
 * is allowed to ignore them until two products need them.
 */
import { VOICE_DEFAULTS } from "./defaults.js"
import type { AudioFrame } from "./types.js"

export type VoiceHook = "audioIn" | "transcript" | "textOut" | "audioOut"

export interface TranscriptItem {
  text: string
  /** false = partial (display), true = final (starts a turn). */
  final: boolean
  startMs?: number
  endMs?: number
}

/** What the brain emits besides text. `activity` re-arms the brain guards. */
export interface BrainEvent {
  type: "activity" | "tool-start"
  name?: string
}

export interface TextChunk {
  text: string
  /** Reserved. */
  end?: boolean
  /** A brain event travels as a chunk with empty text; it is never sent to TTS. */
  event?: BrainEvent
}

export interface HookItems {
  audioIn: AudioFrame
  transcript: TranscriptItem
  textOut: TextChunk
  audioOut: AudioFrame
}

export interface CallContext<H extends VoiceHook = VoiceHook> {
  readonly hook: H
  /** Name of the processor being called. */
  readonly name: string
  /** Opaque, unique per session. */
  readonly callId: string
  /** Assistant turn the item belongs to; absent when it belongs to none. */
  readonly utteranceId?: number
  /** Aborted on barge-in of the item's turn and on close. Pass it to any I/O. */
  readonly signal: AbortSignal
  readonly language?: string
}

/** Reserved: metadata handed to the next processors. */
export interface ProcessorOutput<T> {
  output: T | readonly T[] | null
  meta?: Record<string, unknown>
}

export type TransformResult<T> = T | readonly T[] | null

export interface Transformer<H extends VoiceHook = VoiceHook> {
  readonly kind: "transformer"
  /** Non-empty and unique in the whole array. */
  readonly name: string
  readonly hook: H
  /** Facets this transformer modifies, at least one (`text`, `audio:gain`, ...). */
  readonly modifies: readonly string[]
  /** Earlier transformers (same point) whose facet this one knowingly overlaps. */
  readonly after?: readonly string[]
  /** Overrides the point's default; 0 = no budget. */
  readonly budgetMs?: number
  run(
    input: HookItems[H],
    ctx: CallContext<H>,
  ): TransformResult<HookItems[H]> | Promise<TransformResult<HookItems[H]>>
}

export interface Observer<H extends VoiceHook = VoiceHook> {
  readonly kind: "observer"
  readonly name: string
  readonly hook: H
  /** Default 64; past it the oldest items are dropped (one `dropped` event per burst, with `{count}`). */
  readonly queueMax?: number
  observe(
    input: Readonly<HookItems[H]>,
    ctx: CallContext<H> & { publish(data: Record<string, unknown>): void },
  ): void | Promise<void>
}

export type VoiceProcessor<H extends VoiceHook = VoiceHook> = Transformer<H> | Observer<H>
/** The array order is the execution order. */
export type VoiceProcessors = readonly VoiceProcessor[]

export interface ProcessorEvent {
  type: "error" | "budget-exceeded" | "abandoned" | "dropped" | "bypassed" | "published"
  name: string
  hook: VoiceHook
  elapsedMs?: number
  budgetMs?: number
  error?: Error
  data?: Record<string, unknown>
}

export interface ProcessorStats {
  count: number
  p50Ms: number
  p95Ms: number
  maxMs: number
  overruns: number
}

export type ProcessorConfigErrorCode =
  | "name-missing"
  | "name-duplicate"
  | "conflict"
  | "after-invalid"
  | "facet-missing"
  | "budget-invalid"

export class ProcessorConfigError extends Error {
  constructor(
    readonly code: ProcessorConfigErrorCode,
    readonly names: string[],
    message: string,
    readonly facet?: string,
  ) {
    super(message)
    this.name = "ProcessorConfigError"
  }
}

const HOOKS: readonly VoiceHook[] = ["audioIn", "transcript", "textOut", "audioOut"]

/** Validate the shape of a transformer and return it. */
export function defineTransformer<H extends VoiceHook>(spec: Omit<Transformer<H>, "kind">): Transformer<H> {
  const t = { kind: "transformer" as const, ...spec }
  // Shape only: `after` points at siblings, which the mount check sees.
  validateProcessors([{ ...t, after: undefined }])
  return t
}

/** Validate the shape of an observer and return it. */
export function defineObserver<H extends VoiceHook>(spec: Omit<Observer<H>, "kind">): Observer<H> {
  const o = { kind: "observer" as const, ...spec }
  validateProcessors([o])
  return o
}

/** Mount-time checks; throws `ProcessorConfigError` before any session exists. */
export function validateProcessors(processors: VoiceProcessors): void {
  const seen = new Map<string, number>()
  processors.forEach((p, i) => {
    if (typeof p?.name !== "string" || p.name.trim() === "") {
      throw new ProcessorConfigError("name-missing", [`#${i}`], `processor at index ${i} has no name`)
    }
    if (!HOOKS.includes(p.hook)) {
      throw new ProcessorConfigError("after-invalid", [p.name], `processor "${p.name}" targets unknown hook "${String(p.hook)}"`)
    }
    if (seen.has(p.name)) {
      throw new ProcessorConfigError("name-duplicate", [p.name], `processor name "${p.name}" is used twice`)
    }
    seen.set(p.name, i)
  })
  processors.forEach((p, i) => {
    if (p.kind !== "transformer") return
    if (!Array.isArray(p.modifies) || p.modifies.length === 0) {
      throw new ProcessorConfigError(
        "facet-missing",
        [p.name],
        `transformer "${p.name}" modifies no facet (a processor that modifies nothing is an observer)`,
      )
    }
    if (p.budgetMs !== undefined && !(Number.isFinite(p.budgetMs) && p.budgetMs >= 0)) {
      throw new ProcessorConfigError(
        "budget-invalid",
        [p.name],
        `transformer "${p.name}" has a budgetMs that is negative or not finite (${String(p.budgetMs)})`,
      )
    }
    for (const a of p.after ?? []) {
      const j = seen.get(a)
      const target = j === undefined ? undefined : processors[j]
      if (!target || target.kind !== "transformer" || target.hook !== p.hook || (j as number) >= i) {
        throw new ProcessorConfigError(
          "after-invalid",
          [p.name, a],
          `transformer "${p.name}" lists "${a}" in after, which is not an earlier transformer of the same point`,
        )
      }
    }
  })
  for (let j = 0; j < processors.length; j++) {
    const late = processors[j]!
    if (late.kind !== "transformer") continue
    for (let i = 0; i < j; i++) {
      const early = processors[i]!
      if (early.kind !== "transformer" || early.hook !== late.hook) continue
      const facet = early.modifies.find(f => late.modifies.includes(f))
      if (facet !== undefined && !(late.after ?? []).includes(early.name)) {
        throw new ProcessorConfigError(
          "conflict",
          [early.name, late.name],
          `transformers "${early.name}" and "${late.name}" both modify "${facet}" at ${late.hook}; the later one must list the earlier in after`,
          facet,
        )
      }
    }
  }
}

// ── Output validation ───────────────────────────────────────────────

function validItem(hook: VoiceHook, v: unknown): boolean {
  if (typeof v !== "object" || v === null) return false
  const o = v as Record<string, unknown>
  switch (hook) {
    case "textOut":
      return typeof o.text === "string"
    case "transcript":
      return typeof o.text === "string" && typeof o.final === "boolean"
    default:
      return (
        o.pcm16 instanceof ArrayBuffer &&
        o.pcm16.byteLength % 2 === 0 &&
        typeof o.sampleRate === "number" &&
        Number.isFinite(o.sampleRate) &&
        typeof o.sequenceNumber === "number"
      )
  }
}

// ── Runtime ─────────────────────────────────────────────────────────

export interface ProcessorRuntimeOptions {
  processors: VoiceProcessors
  callId: string
  language?: string
  onEvent?: (e: ProcessorEvent) => void
  /** Monotonic clock in ms. Default `performance.now`. */
  now?: () => number
  budgetMs?: Partial<Record<VoiceHook, number>>
  stopDeadlineMs?: number
  circuitBreaker?: number
}

export interface ProcessorRuntime {
  /** Run one item through the transformers of `hook`; observers get what comes out. */
  process<H extends VoiceHook>(
    hook: H,
    item: HookItems[H],
    scope: { utteranceId?: number; signal: AbortSignal },
  ): Promise<HookItems[H][]>
  has(hook: VoiceHook): boolean
  /** Report processors of points this engine does not run (reserved points). */
  reportReserved(hooks: readonly VoiceHook[]): void
  stats(): Record<string, ProcessorStats>
  /** Aborts every processor signal and stops observers. */
  close(): void
}

const WINDOW = 200
const pct = (sorted: number[], q: number) =>
  sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)]!

export function createProcessorRuntime(opts: ProcessorRuntimeOptions): ProcessorRuntime {
  validateProcessors(opts.processors)
  const D = VOICE_DEFAULTS.processors
  const now = opts.now ?? (() => performance.now())
  const stopDeadlineMs = opts.stopDeadlineMs ?? D.stopDeadlineMs.value
  const breaker = opts.circuitBreaker ?? D.circuitBreaker.value
  const budgetFor = (t: Transformer): number => t.budgetMs ?? opts.budgetMs?.[t.hook] ?? D.budgetMs[t.hook].value
  const session = new AbortController()
  const emit = (e: ProcessorEvent) => {
    try {
      opts.onEvent?.(e)
    } catch {
      // a failing event sink never breaks the path
    }
  }

  const samples = new Map<string, number[]>()
  const overruns = new Map<string, number>()
  const counts = new Map<string, number>()
  const failStreak = new Map<string, number>()
  const bypassed = new Set<string>()
  const record = (name: string, ms: number) => {
    const w = samples.get(name) ?? []
    w.push(ms)
    if (w.length > WINDOW) w.shift()
    samples.set(name, w)
    counts.set(name, (counts.get(name) ?? 0) + 1)
  }

  const transformers = (hook: VoiceHook) =>
    opts.processors.filter((p): p is Transformer => p.kind === "transformer" && p.hook === hook)
  const observersOf = (hook: VoiceHook) =>
    opts.processors.filter((p): p is Observer => p.kind === "observer" && p.hook === hook)

  const fail = (t: Transformer, hook: VoiceHook, e: ProcessorEvent) => {
    emit(e)
    const n = (failStreak.get(t.name) ?? 0) + 1
    failStreak.set(t.name, n)
    if (breaker > 0 && n >= breaker && !bypassed.has(t.name)) {
      bypassed.add(t.name)
      emit({ type: "bypassed", name: t.name, hook, data: { reason: "circuit-breaker" } })
    }
  }

  async function runTransformer<H extends VoiceHook>(
    t: Transformer<H>,
    item: HookItems[H],
    scope: { utteranceId?: number; signal: AbortSignal },
  ): Promise<HookItems[H][] | "aborted"> {
    if (scope.signal.aborted || session.signal.aborted) return "aborted"
    const itemCtl = new AbortController()
    const onAbort = () => itemCtl.abort()
    scope.signal.addEventListener("abort", onAbort, { once: true })
    session.signal.addEventListener("abort", onAbort, { once: true })
    const budget = budgetFor(t)
    const t0 = now()
    let timer: ReturnType<typeof setTimeout> | undefined
    let stopTimer: ReturnType<typeof setTimeout> | undefined
    try {
      const ctx: CallContext<H> = {
        hook: t.hook,
        name: t.name,
        callId: opts.callId,
        ...(scope.utteranceId !== undefined ? { utteranceId: scope.utteranceId } : {}),
        signal: itemCtl.signal,
        ...(opts.language ? { language: opts.language } : {}),
      }
      let called: Promise<unknown>
      try {
        called = Promise.resolve(t.run(item, ctx))
      } catch (err) {
        called = Promise.reject(err)
      }
      called.catch(() => undefined)
      const raced = await Promise.race([
        called.then(
          v => ({ k: "ok" as const, v }),
          e => ({ k: "err" as const, e }),
        ),
        new Promise<{ k: "budget" }>(resolve => {
          if (budget > 0) timer = setTimeout(() => resolve({ k: "budget" }), budget)
        }),
        new Promise<{ k: "abort" }>(resolve => {
          if (itemCtl.signal.aborted) return resolve({ k: "abort" })
          itemCtl.signal.addEventListener("abort", () => resolve({ k: "abort" }), { once: true })
        }),
      ])
      const elapsed = now() - t0
      if (raced.k === "abort") {
        // The turn or the session was cut: do not wait past the stop deadline.
        stopTimer = setTimeout(() => emit({ type: "abandoned", name: t.name, hook: t.hook, elapsedMs: now() - t0 }), stopDeadlineMs)
        void called.then(
          () => clearTimeout(stopTimer),
          () => clearTimeout(stopTimer),
        )
        return "aborted"
      }
      record(t.name, elapsed)
      if (raced.k === "budget" || (budget > 0 && elapsed > budget)) {
        itemCtl.abort()
        overruns.set(t.name, (overruns.get(t.name) ?? 0) + 1)
        // The timer that ended the wait fires at the budget; timer and monotonic clock can differ by a fraction of a ms.
        fail(t, t.hook, { type: "budget-exceeded", name: t.name, hook: t.hook, elapsedMs: Math.max(elapsed, budget), budgetMs: budget })
        return [item]
      }
      if (raced.k === "err") {
        fail(t, t.hook, {
          type: "error",
          name: t.name,
          hook: t.hook,
          error: raced.e instanceof Error ? raced.e : new Error(String(raced.e)),
        })
        return [item]
      }
      const out = raced.v as TransformResult<HookItems[H]>
      const list = out === null ? [] : Array.isArray(out) ? [...out] : [out as HookItems[H]]
      if (!list.every(x => validItem(t.hook, x))) {
        fail(t, t.hook, {
          type: "error",
          name: t.name,
          hook: t.hook,
          error: new Error(`processor "${t.name}" returned an item that is not a valid ${t.hook} item`),
        })
        return [item]
      }
      failStreak.set(t.name, 0)
      return list as HookItems[H][]
    } finally {
      clearTimeout(timer)
      scope.signal.removeEventListener("abort", onAbort)
      session.signal.removeEventListener("abort", onAbort)
    }
  }

  // Observers: bounded queue each, drained sequentially, never awaited.
  const dropped = new Map<string, number>()
  const flushing = new Set<string>()
  const obsQueues = new Map<string, { items: Array<{ item: unknown; utteranceId?: number; signal: AbortSignal }>; running: boolean }>()
  function offer(o: Observer, item: unknown, scope: { utteranceId?: number; signal: AbortSignal }) {
    let q = obsQueues.get(o.name)
    if (!q) obsQueues.set(o.name, (q = { items: [], running: false }))
    const max = o.queueMax ?? D.observerQueueMax.value
    q.items.push({ item, ...scope })
    while (q.items.length > max) {
      q.items.shift()
      dropped.set(o.name, (dropped.get(o.name) ?? 0) + 1)
    }
    if (dropped.has(o.name) && !flushing.has(o.name)) {
      flushing.add(o.name)
      queueMicrotask(() => {
        flushing.delete(o.name)
        const count = dropped.get(o.name) ?? 0
        dropped.delete(o.name)
        if (count > 0) emit({ type: "dropped", name: o.name, hook: o.hook, data: { count } })
      })
    }
    if (q.running) return
    q.running = true
    const state = q
    void (async () => {
      while (state.items.length > 0 && !session.signal.aborted) {
        const next = state.items.shift()!
        if (next.signal.aborted) continue
        const frozen =
          typeof next.item === "object" && next.item !== null && !(next.item as { pcm16?: unknown }).pcm16
            ? Object.freeze({ ...(next.item as object) })
            : next.item
        try {
          let settled = false
          const ctx = {
            hook: o.hook,
            name: o.name,
            callId: opts.callId,
            ...(next.utteranceId !== undefined ? { utteranceId: next.utteranceId } : {}),
            signal: next.signal,
            ...(opts.language ? { language: opts.language } : {}),
            publish: (data: Record<string, unknown>) => {
              if (settled || session.signal.aborted) return
              emit({ type: "published", name: o.name, hook: o.hook, data })
            },
          }
          try {
            await (o as Observer<VoiceHook>).observe(frozen as never, ctx as never)
          } finally {
            settled = true
          }
        } catch (err) {
          emit({ type: "error", name: o.name, hook: o.hook, error: err instanceof Error ? err : new Error(String(err)) })
        }
      }
      state.running = false
    })()
  }

  const tails = new Map<VoiceHook, Promise<unknown>>()

  return {
    has: hook => opts.processors.some(p => p.hook === hook),
    reportReserved(hooks) {
      for (const p of opts.processors) {
        if (hooks.includes(p.hook)) {
          emit({ type: "bypassed", name: p.name, hook: p.hook, data: { reason: "reserved-hook" } })
        }
      }
    },
    process(hook, item, scope) {
      const run = async (): Promise<HookItems[typeof hook][]> => {
        let items: HookItems[typeof hook][] = [item]
        for (const t of transformers(hook)) {
          if (bypassed.has(t.name)) continue
          const next: HookItems[typeof hook][] = []
          for (const it of items) {
            const r = await runTransformer(t as Transformer<typeof hook>, it, scope)
            if (r === "aborted") return []
            next.push(...r)
          }
          items = next
          if (items.length === 0) break
        }
        for (const o of observersOf(hook)) for (const it of items) offer(o, it, scope)
        return items
      }
      // One item at a time per point, in arrival order, whatever finishes first.
      const prev = tails.get(hook) ?? Promise.resolve()
      const result = prev.then(run, run)
      tails.set(hook, result.catch(() => undefined))
      return result
    },
    stats() {
      const out: Record<string, ProcessorStats> = {}
      for (const [name, w] of samples) {
        const sorted = [...w].sort((a, b) => a - b)
        out[name] = {
          count: counts.get(name) ?? 0,
          p50Ms: pct(sorted, 0.5),
          p95Ms: pct(sorted, 0.95),
          maxMs: sorted[sorted.length - 1] ?? 0,
          overruns: overruns.get(name) ?? 0,
        }
      }
      return out
    },
    close() {
      session.abort()
    },
  }
}
