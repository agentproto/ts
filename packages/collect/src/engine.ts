import {
  CollectTask,
  type Connector,
  type ConnectorRegistry,
  type FetchedRaw,
  type FetchResult,
  createConnectorRegistry,
  listConnectors,
  type ParseResult,
  type RecipeSource,
} from "./connector"
import { computeCoverage } from "./coverage"
import { createSampler, type Sampler } from "./sampling"
import { canonicalUrl, itemIdFromUrl, sha256Hex, textFingerprint } from "./ids"
import {
  Actor,
  CollectItem,
  type ConnectorReport,
  type MetricName,
  type FailureCause,
  Observation,
  Pickup,
  Recipe,
  type RunReport,
} from "./schemas"
import {
  type CollectStore,
  type EventRecord,
  type PlanEntry,
  type StoreLock,
  type TaskRecord,
  itemSeenKeys,
  readAll,
  seenKey,
  stableStringify,
} from "./store"
import {
  type BrowserTransport,
  type FetchTransport,
  type HttpTransport,
  type SecretsPort,
  MissingSecretError,
  TransportError,
  type TransportName,
  type TransportSet,
} from "./transport"

export interface Clock {
  /** Milliseconds since the epoch. */
  now(): number
  sleep(ms: number, signal?: AbortSignal): Promise<void>
}

const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms, signal) =>
    new Promise<void>((resolve) => {
      if (signal?.aborted) return resolve()
      const t = setTimeout(done, ms)
      const onAbort = () => {
        clearTimeout(t)
        done()
      }
      function done() {
        signal?.removeEventListener("abort", onAbort)
        resolve()
      }
      signal?.addEventListener("abort", onAbort, { once: true })
    }),
}

export interface CollectorOptions {
  store: CollectStore
  transports: TransportSet
  secrets?: SecretsPort
  /** A list, or a registry. Defaults to the process-wide registry (`registerConnector`). */
  connectors?: Connector[] | ConnectorRegistry
  clock?: Clock
  /** Source of randomness for run ids: returns a number in [0, 1). */
  random?: () => number
}

export interface RunEvent extends EventRecord {
  runId: string
}

export interface RunOptions {
  /** Stop taking tasks when aborted; pending tasks stay pending and a partial report is written. */
  signal?: AbortSignal
  onEvent?: (event: RunEvent) => void
  runId?: string
}

/** The run stopped on an error of its own (the store failed, a connector could not plan). The run is left resumable. */
export class CollectRunError extends Error {
  readonly code = "RUN_ERROR"
  constructor(
    readonly runId: string,
    override readonly cause: unknown,
  ) {
    super(`run ${runId} failed: ${cause instanceof Error ? cause.message : String(cause)}`)
    this.name = "CollectRunError"
  }
}

/**
 * One collector drives one store: the store lock allows a single run at a
 * time, so the host gate and the browser lane below are per collector and
 * per run by construction. Do not share a browser between two collectors.
 */
export interface Collector {
  /** Plan the recipe and run it. Creates a new run. */
  run(recipe: Recipe | unknown, options?: RunOptions): Promise<RunReport>
  /**
   * Continue a run from its log. Reloads the frozen recipe, the plan and every
   * task as last recorded; `done` tasks are skipped and never fetched again,
   * `pending`, `failed` and `skipped` tasks are redone (a skipped task is
   * re-checked against the transports and secrets available now; a connector
   * that is no longer registered has its tasks reported skipped). Tasks come
   * back in their recorded global order. The per-connector and total caps are
   * restored from the task states: a task that was `done` or `failed` already
   * used its budget, so retrying it takes none, while a task that never
   * started does. The report covers the whole run, earlier attempts included.
   * A challenge stop does not carry over: the connector is tried again.
   */
  resume(runId: string, options?: Omit<RunOptions, "runId">): Promise<RunReport>
}

const FALLBACK_STATUSES = new Set([401, 403, 429])
const DEFAULT_WORKERS = 8

const key = (connector: string, taskId: string) => `${connector}/${taskId}`

type Task = ReturnType<typeof CollectTask.parse>

interface Entry {
  key: string
  connector: Connector
  task: Task
  /** Global start order: connector index, plan index, then follow-up depth and index. */
  order: number[]
  /** Index in the connector's usable transports of the next attempt. */
  attempt: number
  started: boolean
  t0: number
  escalations: Array<{ from: string; to: string }>
  lastTransport?: TransportName
}

interface ConnectorState {
  id: string
  connector?: Connector
  transports: TransportName[]
  skipReason?: string
  started: number
  cap?: number
  /** A challenge stopped the connector for the rest of the run. */
  stopped: boolean
  /** Aborts this connector's in-flight requests: on a challenge, or when the run is cancelled. */
  controller: AbortController
}

interface Failure {
  fallback: boolean
  /** A verification page: stop the connector, never bypass. */
  challenge: boolean
  cause: FailureCause
  message: string
}

/**
 * A verification page seen by the browser stops the connector (it is never
 * bypassed). Seen by `http` or `api` it moves the task to the next transport,
 * and fails the task with cause `challenge` when none remains.
 */
function challengeFailure(browser: boolean, message: string): Failure {
  return { fallback: !browser, challenge: browser, cause: "challenge", message }
}

function classifyError(e: unknown, browser: boolean): Failure {
  if (e instanceof TransportError) {
    const message = e.message
    // A challenge always wins; otherwise a non-2xx status decides, whatever cause the error names.
    if (e.cause !== "challenge" && e.status !== undefined && (e.status < 200 || e.status >= 300)) {
      return FALLBACK_STATUSES.has(e.status)
        ? { fallback: true, challenge: false, cause: "blocked", message }
        : { fallback: false, challenge: false, cause: "http", message }
    }
    switch (e.cause) {
      case "challenge":
        return challengeFailure(browser, message)
      case "blocked":
        return { fallback: true, challenge: false, cause: "blocked", message }
      case "empty":
        return { fallback: true, challenge: false, cause: "empty", message }
      case "network":
        return { fallback: false, challenge: false, cause: "network", message }
      case "http":
        return e.status !== undefined && FALLBACK_STATUSES.has(e.status)
          ? { fallback: true, challenge: false, cause: "blocked", message }
          : { fallback: false, challenge: false, cause: "http", message }
    }
  }
  return { fallback: false, challenge: false, cause: "other", message: e instanceof Error ? e.message : String(e) }
}

/** Status first: 401/403/429 fall back, other non-2xx statuses are `http` and final, a bodyless 2xx is `empty`. */
function classifyRaw(raw: FetchedRaw, browser: boolean): Failure | undefined {
  if (raw.challenge) return challengeFailure(browser, "challenge page")
  const s = raw.httpStatus
  if (s !== undefined) {
    if (FALLBACK_STATUSES.has(s)) return { fallback: true, challenge: false, cause: "blocked", message: `HTTP ${s}` }
    if (s < 200 || s >= 300) return { fallback: false, challenge: false, cause: "http", message: `HTTP ${s}` }
  }
  if (raw.bytes.byteLength === 0) return { fallback: true, challenge: false, cause: "empty", message: "empty content" }
  return undefined
}

function compareOrder(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i]
    const y = b[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    if (x !== y) return x - y
  }
  return 0
}

function insertSorted(queue: Entry[], entry: Entry): void {
  let i = queue.length
  while (i > 0 && compareOrder(queue[i - 1]!.order, entry.order) > 0) i--
  queue.splice(i, 0, entry)
}

/** Runs one function at a time, in call order. */
function serial() {
  let tail: Promise<unknown> = Promise.resolve()
  return <T>(fn: () => Promise<T>): Promise<T> => {
    const p = tail.then(fn)
    tail = p.then(
      () => undefined,
      () => undefined,
    )
    return p
  }
}

function sampledOf(rows: Array<{ decision: string; rule?: string }>) {
  const dropped: Record<string, number> = {}
  let kept = 0
  for (const r of rows) {
    if (r.decision === "kept") kept++
    else dropped[r.rule ?? "unknown"] = (dropped[r.rule ?? "unknown"] ?? 0) + 1
  }
  return { candidates: rows.length, kept, dropped }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host.toLowerCase()
  } catch {
    return ""
  }
}

function randomId(random: () => number): string {
  let s = ""
  for (let i = 0; i < 6; i++) s += Math.floor(random() * 36).toString(36)
  return s
}

function toError(e: unknown): Error {
  if (e instanceof Error) return e
  let text: string
  try {
    text = typeof e === "string" ? e : (JSON.stringify(e) ?? String(e))
  } catch {
    text = String(e)
  }
  return new Error(`rejected with ${text}`)
}

function abortError(): Error {
  return Object.assign(new Error("aborted"), { name: "AbortError" })
}

interface TaskCounters {
  items: number
  newItems: number
  duplicates: number
  observations: number
  metricValues: number
}

interface Prepared {
  ref: string
  items: CollectItem[]
  observations: Observation[]
  actors: Actor[]
  pickups: Pickup[]
}

export function createCollector(options: CollectorOptions): Collector {
  const { store, transports } = options
  const clock = options.clock ?? systemClock
  const random = options.random ?? Math.random
  const secrets: SecretsPort = options.secrets ?? { get: async () => undefined }
  const registry: ConnectorRegistry = Array.isArray(options.connectors)
    ? createConnectorRegistry(options.connectors)
    : (options.connectors ?? { register() {}, get: (id) => listConnectors().find((c) => c.id === id), list: listConnectors })
  const iso = () => new Date(clock.now()).toISOString()

  /**
   * Per-host gate shared by every connector and every request, zero delay
   * included. Starts on a host go through a FIFO, one at a time; each waits
   * until the previous start plus the larger of its own interval and the
   * previous start's, and measures that again when it wakes up.
   */
  const gates = new Map<string, { tail: Promise<void>; lastStart?: number; lastInterval: number }>()
  async function gate(url: string, intervalMs: number, signal?: AbortSignal): Promise<void> {
    const host = hostOf(url)
    let g = gates.get(host)
    if (!g) gates.set(host, (g = { tail: Promise.resolve(), lastInterval: 0 }))
    const state = g
    const mine = state.tail.then(async () => {
      for (;;) {
        if (signal?.aborted) throw abortError()
        const gap = Math.max(intervalMs, state.lastInterval)
        const wait = state.lastStart === undefined ? 0 : state.lastStart + gap - clock.now()
        if (wait <= 0) break
        await clock.sleep(wait, signal)
      }
      state.lastStart = clock.now()
      state.lastInterval = intervalMs
    })
    state.tail = mine.then(
      () => undefined,
      () => undefined,
    )
    await mine
  }

  /** The request's own signal and the collector's, whichever fires first. */
  function both(a?: AbortSignal, b?: AbortSignal): AbortSignal | undefined {
    return a && b ? AbortSignal.any([a, b]) : (a ?? b)
  }

  function handleFor(name: TransportName, connector: Connector, signal?: AbortSignal): FetchTransport {
    const delay = connector.pace.delayMs
    if (name === "browser") {
      const b = transports.browser as BrowserTransport
      return {
        name,
        browser: {
          open: async (url) => {
            await gate(url, delay, signal)
            return b.open(url)
          },
          evaluate: (p, s) => b.evaluate(p, s),
          fetchInPage: async (p, r) => {
            const sig = both(r.signal, signal)
            await gate(r.url, delay, sig)
            return b.fetchInPage(p, { ...r, signal: sig })
          },
          scroll: (p, o) => b.scroll(p, o),
          waitFor: (p, o) => b.waitFor(p, o),
          close: (p) => b.close(p),
        },
      }
    }
    const h = transports[name] as HttpTransport
    return {
      name,
      http: {
        request: async (req) => {
          const sig = both(req.signal, signal)
          await gate(req.url, delay, sig)
          return h.request({ ...req, signal: sig })
        },
      },
    }
  }

  async function connectorState(id: string, recipe: Recipe): Promise<ConnectorState> {
    const connector = registry.get(id)
    const state: ConnectorState = { id, connector, transports: [], started: 0, stopped: false, controller: new AbortController() }
    if (!connector) {
      state.skipReason = `connector "${id}" is not registered`
      return state
    }
    state.cap = recipe.caps?.perConnector ?? connector.pace.maxTasksPerRun
    state.transports = connector.transports.filter((t) => transports[t] !== undefined)
    if (connector.access.level === "key") {
      const secret = await secrets.get(connector.access.secret)
      if (!secret) {
        state.skipReason = `missing_secret:${connector.access.secret}`
        state.transports = []
        return state
      }
    }
    if (state.transports.length === 0) {
      state.skipReason = `no usable transport (declared: ${connector.transports.join(", ")}; provided: ${
        (["api", "http", "browser"] as const).filter((t) => transports[t] !== undefined).join(", ") || "none"
      })`
    }
    return state
  }

  async function execute(
    runId: string,
    recipe: Recipe,
    mode: "new" | "resume",
    opts: Omit<RunOptions, "runId">,
  ): Promise<RunReport> {
    const { signal, onEvent } = opts
    const lock: StoreLock = await store.acquireLock()
    const active = new Set<Promise<void>>()
    try {
      return await executeLocked(runId, recipe, mode, signal, onEvent, active)
    } catch (e) {
      throw e instanceof CollectRunError ? e : new CollectRunError(runId, e)
    } finally {
      // Settle whatever is still running, then release the lock last.
      await Promise.allSettled([...active])
      await lock.release()
    }
  }

  async function executeLocked(
    runId: string,
    recipe: Recipe,
    mode: "new" | "resume",
    signal: AbortSignal | undefined,
    onEvent: RunOptions["onEvent"],
    active: Set<Promise<void>>,
  ): Promise<RunReport> {
    const startedAt = (mode === "resume" ? (await store.readReport(runId))?.startedAt : undefined) ?? iso()
    const write = serial()
    const emit = (type: string, data?: Record<string, unknown>) =>
      write(async () => {
        const event: EventRecord = { at: iso(), type, ...(data ? { data } : {}) }
        await store.appendEvent(runId, event)
        // A failing listener, sync or async, never breaks the run: it is logged as an `error` event.
        const report = (e: unknown) => {
          const p = write(() =>
            store.appendEvent(runId, { at: iso(), type: "error", data: { source: "onEvent", message: toError(e).message } }),
          ).then(
            () => undefined,
            () => undefined,
          )
          active.add(p)
          void p.finally(() => active.delete(p))
        }
        try {
          void Promise.resolve(onEvent?.({ ...event, runId })).catch(report)
        } catch (e) {
          report(e)
        }
      })
    const record = (r: Omit<TaskRecord, "updatedAt">) =>
      write(() => store.appendTask(runId, { ...r, updatedAt: iso() }))

    if (mode === "new") await store.createRun(runId, recipe)
    await emit("run.start", { mode, recipeName: recipe.name })
    // Counters are rebuilt from sampling.jsonl, so a resumed run decides like an uninterrupted one.
    const samplers = new Map<string, Sampler>()
    const samplerFor = async (connector: Connector): Promise<Sampler> => {
      let s = samplers.get(connector.id)
      if (!s) {
        const prior = (await readAll(store.sampling(runId))).records.filter((r) => r.connector === connector.id)
        const primary = connector.counters.find((c) => c.primary)?.name
        s = createSampler(recipe.sampling!, primary, prior)
        samplers.set(connector.id, s)
      }
      return s
    }

    const connectorIds = [...new Set(recipe.sources.map((s) => s.connector))]
    const states = new Map<string, ConnectorState>()
    for (const id of connectorIds) states.set(id, await connectorState(id, recipe))
    const abortConnectors = () => {
      for (const st of states.values()) st.controller.abort()
    }
    if (signal?.aborted) abortConnectors()
    else signal?.addEventListener("abort", abortConnectors, { once: true })
    const payloadOf = (t: Task) => ({ id: t.id, ...(t.kind ? { kind: t.kind } : {}), params: t.params })

    const known = new Set<string>()
    const entries: Entry[] = []
    /** Tasks that already used their budget in an earlier invocation (done or failed). */
    const counted = new Set<string>()
    const mkEntry = (state: ConnectorState, k: string, task: Task, order: number[]): Entry => ({
      key: k,
      connector: state.connector!,
      task,
      order,
      attempt: 0,
      started: false,
      t0: 0,
      escalations: [],
    })

    /** Root tasks of the recipe. `plan()` is deterministic, so this can be regenerated from the frozen recipe. */
    const buildPlan = (): PlanEntry[] => {
      const plan: PlanEntry[] = []
      const seen = new Set<string>()
      connectorIds.forEach((id, ci) => {
        const state = states.get(id)!
        if (!state.connector) return
        const sources: RecipeSource[] = recipe.sources.filter((s) => s.connector === id)
        let index = 0
        for (const t of state.connector.plan(recipe, sources)) {
          const task = CollectTask.parse(t)
          const k = key(id, task.id)
          if (seen.has(k)) continue
          seen.add(k)
          plan.push({ taskId: k, connector: id, order: [ci, index++], payload: payloadOf(task) })
        }
      })
      return plan
    }

    // The whole root plan lands in one atomic write, before anything runs. A resumed run
    // with no plan file (it never got one) is planned again, never taken as an empty plan.
    let plan = mode === "resume" ? await store.readPlan(runId) : undefined
    if (!plan) {
      const built = buildPlan()
      await write(() => store.writePlan(runId, built))
      plan = built
    }
    if (mode === "new") {
      for (const p of plan) {
        const st = states.get(p.connector)
        if (st && !st.skipReason) {
          await record({ taskId: p.taskId, connector: p.connector, status: "pending", order: p.order, payload: p.payload })
        }
      }
    }
    {
      const { records } = await readAll(store.tasks(runId))
      const byKey = new Map<string, { connector: string; order: number[]; payload: unknown; rec?: TaskRecord }>()
      plan.forEach((p) => byKey.set(p.taskId, { connector: p.connector, order: p.order, payload: p.payload }))
      records.forEach((r, i) => {
        const prior = byKey.get(r.taskId)
        const ci = Math.max(connectorIds.indexOf(r.connector), 0)
        byKey.set(r.taskId, {
          connector: r.connector,
          order: r.order ?? prior?.order ?? [ci, Number.MAX_SAFE_INTEGER, i],
          payload: r.payload ?? prior?.payload,
          rec: r,
        })
      })
      for (const [k, v] of byKey) {
        known.add(k)
        const status = v.rec?.status ?? "pending"
        const state = states.get(v.connector)
        // A task that started (even if the process died before it ended) used its budget.
        if (status === "done" || status === "failed" || status === "started") {
          counted.add(k)
          if (state) state.started++
        }
        if (status === "done") continue
        const task = CollectTask.safeParse(v.payload)
        if (!task.success) continue
        if (!state?.connector || state.skipReason) {
          const reason = state?.skipReason ?? `connector "${v.connector}" is not registered`
          if (v.rec?.status !== "skipped" || v.rec.reason !== reason) {
            await record({ taskId: k, connector: v.connector, status: "skipped", reason, order: v.order, payload: payloadOf(task.data) })
          }
          continue
        }
        entries.push(mkEntry(state, k, task.data, v.order))
      }
      for (const st of states.values()) {
        if (st.skipReason) await emit("connector.skipped", { connector: st.id, reason: st.skipReason })
      }
    }

    // Recover seen keys whose write was lost, and give old keys an owner.
    for await (const item of store.items()) {
      for (const k of itemSeenKeys(item)) if ((await store.seenGet(k)) === undefined) await store.seenAdd(k, item.id)
    }

    // Scheduling: two lanes, each attempt is queued in the lane of its own transport.
    const workers = recipe.workers ?? DEFAULT_WORKERS
    const poolQueue: Entry[] = []
    const browserQueue: Entry[] = []
    const laneQueue = (e: Entry) =>
      states.get(e.connector.id)?.transports[e.attempt] === "browser" ? browserQueue : poolQueue
    const enqueue = (e: Entry) => insertSorted(laneQueue(e), e)
    let poolActive = 0
    let browserActive = 0
    let totalStarted = counted.size
    let commitsActive = 0
    // Commit stage: fetch and parse run in parallel, but outcomes are committed
    // (sampling, dedup, writes) in `order`. A slot is resolved when its task is done,
    // failed or skipped; a task in fallback keeps its slot.
    const slots: Entry[] = []
    const waiters = new Map<Entry, () => void>()
    const wakeHead = () => {
      const head = slots[0]
      const w = head && waiters.get(head)
      if (w) {
        waiters.delete(head!)
        w()
      }
    }
    // Back-pressure: results held behind a slow head are bounded. A task is launched only
    // while fewer than `lookahead` tasks are live (fetching or held) and its slot is within
    // `lookahead` positions of the cursor. The head, and a task in fallback (already live),
    // are always launchable, so progress never waits on the window.
    const lookahead = recipe.lookahead ?? 4 * workers
    const live = new Set<Entry>()
    const resolveSlot = (e: Entry) => {
      const i = slots.indexOf(e)
      if (i >= 0) slots.splice(i, 1)
      live.delete(e)
      wakeHead()
      pump()
    }
    const launchable = (e: Entry) => live.has(e) || slots[0] === e || !slots.includes(e) || (live.size < lookahead && slots.indexOf(e) < lookahead)
    const registerSlot = (e: Entry) => insertSorted(slots, e)
    /** True once every earlier slot is resolved; false when the run stops first (the task stays pending). */
    async function awaitTurn(e: Entry): Promise<boolean> {
      while (slots.length > 0 && slots[0] !== e && slots.includes(e)) {
        if (stopping()) return false
        await new Promise<void>((resolve) => waiters.set(e, resolve))
      }
      return true
    }
    for (const e of entries) {
      registerSlot(e)
      enqueue(e)
    }
    let fatal: Error | undefined
    const aborted = () => signal?.aborted === true
    const stopping = () => aborted() || fatal !== undefined
    let finish: () => void = () => {}
    const finished = new Promise<void>((resolve) => {
      finish = resolve
    })
    const check = () => {
      if (stopping()) for (const [e, w] of [...waiters]) (waiters.delete(e), w())
      if (poolActive === 0 && browserActive === 0 && commitsActive === 0 && (stopping() || (!poolQueue.length && !browserQueue.length))) finish()
    }
    const pump = () => {
      if (!stopping()) {
        while (poolActive < workers && poolQueue.length && launchable(poolQueue[0]!)) launch(poolQueue.shift()!, "pool")
        if (browserActive === 0 && browserQueue.length && launchable(browserQueue[0]!)) launch(browserQueue.shift()!, "browser")
        // Nothing running and nothing launchable: never stall on the window.
        if (poolActive === 0 && browserActive === 0 && commitsActive === 0) {
          const first = [poolQueue[0], browserQueue[0]].filter((e): e is Entry => e !== undefined).sort((a, b) => compareOrder(a.order, b.order))[0]
          if (first) launch((first === poolQueue[0] ? poolQueue : browserQueue).shift()!, first === poolQueue[0] ? "pool" : "browser")
        }
      }
      check()
    }
    const launch = (entry: Entry, lane: "pool" | "browser") => {
      live.add(entry)
      if (lane === "pool") poolActive++
      else browserActive++
      const p: Promise<void> = attempt(entry)
        .catch((e) => {
          if (stopping() && (e as { name?: string })?.name === "AbortError") return
          fatal ??= toError(e)
        })
        .finally(() => {
          active.delete(p)
          if (lane === "pool") poolActive--
          else browserActive--
          pump()
        })
      active.add(p)
    }
    signal?.addEventListener("abort", check, { once: true })

    const writtenActors = new Set<string>()

    async function skip(entry: Entry, reason: string, why: string) {
      await record({
        taskId: entry.key,
        connector: entry.connector.id,
        status: "skipped",
        reason,
        order: entry.order,
        payload: payloadOf(entry.task),
        escalations: entry.escalations,
      })
      await emit("task.skipped", { connector: entry.connector.id, taskId: entry.task.id, reason: why })
      resolveSlot(entry)
    }

    /**
     * A challenge stops the connector. The flag is set and the queued tasks are taken out
     * of both lanes synchronously, so the pump cannot launch one of them in between.
     */
    function haltConnector(state: ConnectorState): Entry[] {
      state.stopped = true
      state.controller.abort()
      const removed: Entry[] = []
      for (const q of [poolQueue, browserQueue]) {
        for (let i = q.length - 1; i >= 0; i--) {
          if (q[i]!.connector.id === state.id) removed.unshift(...q.splice(i, 1))
        }
      }
      return removed.sort((x, y) => compareOrder(x.order, y.order))
    }

    async function skipHalted(state: ConnectorState, removed: Entry[], first: boolean) {
      if (first) await emit("connector.stopped", { connector: state.id, reason: "challenge" })
      for (const e of removed) await skip(e, "challenge", "challenge")
    }

    async function prepare(
      entry: Entry,
      parsed: ParseResult,
      ref: string,
      rawHash: string,
      fetchedAt: string,
      transport: TransportName,
    ): Promise<Prepared> {
      const keyOf = (kind: string, index: number) => sha256Hex(JSON.stringify([runId, entry.key, rawHash, kind, index]))
      const items: CollectItem[] = []
      for (const p of parsed.items ?? []) {
        const canonical = p.canonicalUrl ?? (p.url ? canonicalUrl(p.url) : undefined)
        const id = p.id ?? (canonical ? await itemIdFromUrl(p.source, canonical) : undefined)
        if (!id) throw new Error("an item needs an id or a url")
        const contentId = p.contentId ?? (p.text ? await textFingerprint(p.text) : undefined)
        const item = CollectItem.parse({
          ...p,
          id,
          canonicalUrl: canonical,
          contentId,
          firstSeenAt: p.firstSeenAt ?? fetchedAt,
          runId,
          rawRefs: [...new Set([...(p.rawRefs ?? []), ref])],
        })
        if (entry.connector.ext && item.ext !== undefined) entry.connector.ext.parse(item.ext)
        items.push(item)
      }
      // Identity of a record: run, task, raw and position in the parse output.
      const observations: Observation[] = []
      for (const [i, o] of (parsed.observations ?? []).entries()) {
        observations.push(
          Observation.parse({ measuredAt: fetchedAt, transport, rawRef: ref, ...o, runId, taskId: entry.key, recordKey: await keyOf("observation", i) }),
        )
      }
      const pickups: Pickup[] = []
      for (const [i, p] of (parsed.pickups ?? []).entries()) {
        pickups.push(
          Pickup.parse({
            firstSeenAt: fetchedAt,
            measuredAt: fetchedAt,
            ...p,
            runId,
            taskId: entry.key,
            recordKey: await keyOf("pickup", i),
            evidence: { rawRef: ref, ...p.evidence },
          }),
        )
      }
      return { ref, items, observations, actors: (parsed.actors ?? []).map((a) => Actor.parse(a)), pickups }
    }

    /**
     * Sampling of the candidates a task's parse returned. Tasks of kind `read`
     * (fetch by URL) are not sampled, and neither are candidates whose item
     * already exists (they only add their observation). The whole decision
     * batch is persisted in one append before any counter moves. A dropped
     * candidate loses its item, observations, pickups and the actors only it
     * referenced.
     */
    async function sample(entry: Entry, prepared: Prepared[]): Promise<Prepared[]> {
      if (recipe.sampling === undefined || entry.task.kind === "read") return prepared
      const known = new Set<string>()
      const candidates = []
      for (const p of prepared) {
        for (const item of p.items) {
          const metrics: Partial<Record<MetricName, number>> = {}
          for (const o of p.observations) {
            if (o.itemId !== item.id) continue
            for (const [name, v] of Object.entries(o.metrics)) {
              if (typeof v === "number" && metrics[name as MetricName] === undefined) metrics[name as MetricName] = v
            }
          }
          const url = item.canonicalUrl ?? item.url
          const idKey = seenKey("id", item.id)
          if (
            (await store.seenGet(idKey)) !== undefined ||
            (await store.seenHas(idKey)) ||
            (item.canonicalUrl !== undefined && (await store.seenGet(seenKey("url", item.canonicalUrl))) !== undefined)
          ) {
            known.add(item.id)
          }
          candidates.push({ id: item.id, kind: item.kind, metrics, url, target: item.links?.target, outboundLinks: item.outboundLinks })
        }
      }
      const sampler = await samplerFor(entry.connector)
      const { lines, dropped } = sampler.plan(entry.key, candidates, known)
      if (lines.length > 0) {
        const at = iso()
        await store.appendSamplingBatch(
          runId,
          lines.map((d) => ({ ...d, connector: entry.connector.id, taskId: entry.key, at })),
        )
        sampler.apply(lines)
      }
      if (dropped.size === 0) return prepared
      const refsOf = (i: CollectItem) => [i.authorRef, i.submitterRef, ...(i.parts ?? []).map((part) => part.authorRef)]
      const keptRefs = new Set(prepared.flatMap((p) => p.items.filter((i) => !dropped.has(i.id))).flatMap(refsOf))
      const droppedRefs = new Set(prepared.flatMap((p) => p.items.filter((i) => dropped.has(i.id))).flatMap(refsOf))
      return prepared.map((p) => ({
        ...p,
        items: p.items.filter((i) => !dropped.has(i.id)),
        observations: p.observations.filter((o) => !dropped.has(o.itemId)),
        pickups: p.pickups.filter((k) => !dropped.has(k.itemId) && !(k.pickupItemId && dropped.has(k.pickupItemId))),
        actors: p.actors.filter((a) => !droppedRefs.has(a.ref) || keptRefs.has(a.ref)),
      }))
    }

    /** The owner of an item id: where an observation or a link to it must point. */
    async function resolve(idMap: Map<string, string>, id: string): Promise<string> {
      return idMap.get(id) ?? (await store.seenGet(seenKey("id", id))) ?? id
    }

    async function ingest(prepared: Prepared[], counters: TaskCounters) {
      const idMap = new Map<string, string>()
      const created: CollectItem[] = []
      for (const { ref, items } of prepared) {
        counters.items += items.length
        for (const item of items) {
          const idKey = seenKey("id", item.id)
          let owner = await store.seenGet(idKey)
          if (owner === undefined && (await store.seenHas(idKey))) owner = item.id
          let level = owner ? 1 : 0
          if (!owner && item.canonicalUrl) {
            owner = await store.seenGet(seenKey("url", item.canonicalUrl))
            if (owner) level = 2
          }
          if (owner) {
            idMap.set(item.id, owner)
            if (level === 2) await store.seenAdd(idKey, owner)
            // After a resume, a hit on an item this run already wrote from the same raw is the same task redone.
            const existing = mode === "resume" ? await store.getItem(owner) : undefined
            if (existing?.runId === runId && existing.rawRefs?.includes(ref)) counters.newItems++
            else counters.duplicates++
            continue
          }
          await store.upsertItem(item)
          for (const k of itemSeenKeys(item)) await store.seenAdd(k, item.id)
          created.push(item)
          counters.newItems++
        }
      }
      // Links follow the aliases decided above.
      for (const item of created) {
        if (!item.links) continue
        const links = { ...item.links }
        let changed = false
        for (const name of ["target", "parent", "root", "quoted"] as const) {
          const v = links[name]
          if (v === undefined) continue
          const r = await resolve(idMap, v)
          if (r !== v) {
            links[name] = r
            changed = true
          }
        }
        if (changed) await store.upsertItem({ ...item, links })
      }
      for (const { observations, actors, pickups } of prepared) {
        for (const o of observations) {
          await store.appendObservation({ ...o, itemId: await resolve(idMap, o.itemId) })
          counters.observations++
          counters.metricValues += Object.keys(o.metrics).length
        }
        for (const a of actors) {
          const k = stableStringify(a)
          if (writtenActors.has(k)) continue
          writtenActors.add(k)
          await store.appendActor(a)
        }
        for (const p of pickups) {
          await store.appendPickup({
            ...p,
            itemId: await resolve(idMap, p.itemId),
            ...(p.pickupItemId ? { pickupItemId: await resolve(idMap, p.pickupItemId) } : {}),
          })
        }
      }
    }

    async function finishFailed(entry: Entry, failure: Failure) {
      const durationMs = clock.now() - entry.t0
      await record({
        taskId: entry.key,
        connector: entry.connector.id,
        status: "failed",
        transport: entry.lastTransport,
        cause: failure.cause,
        reason: failure.challenge ? "challenge" : failure.message,
        order: entry.order,
        payload: payloadOf(entry.task),
        escalations: entry.escalations,
        counters: { items: 0, newItems: 0, duplicates: 0, observations: 0, metricValues: 0, durationMs },
      })
      await emit("task.end", {
        connector: entry.connector.id,
        taskId: entry.task.id,
        status: "failed",
        cause: failure.cause,
        message: failure.message,
        durationMs,
      })
      resolveSlot(entry)
    }

    /** One attempt on one transport. A fallback queues the next attempt in the next transport's lane. */
    async function attempt(entry: Entry): Promise<void> {
      const connector = entry.connector
      const state = states.get(connector.id)!
      if (stopping()) return // stays pending
      if (state.stopped) return skip(entry, "challenge", "challenge")
      if (!entry.started) {
        if (!counted.has(entry.key)) {
          if (state.cap !== undefined && state.started >= state.cap) {
            return skip(entry, `per-connector cap reached (${state.cap})`, "cap")
          }
          if (recipe.caps?.total !== undefined && totalStarted >= recipe.caps.total) {
            return skip(entry, `total cap reached (${recipe.caps.total})`, "total cap")
          }
          state.started++
          totalStarted++
          // One durable record per unique start: a crash after it still counts against the budget.
          await record({
            taskId: entry.key,
            connector: connector.id,
            status: "started",
            order: entry.order,
            payload: payloadOf(entry.task),
          })
        }
        entry.started = true
        entry.t0 = clock.now()
        await emit("task.start", { connector: connector.id, taskId: entry.task.id })
      }

      const name = state.transports[entry.attempt]!
      entry.lastTransport = name
      let result: FetchResult | undefined
      let failure: Failure | undefined
      let failedRaws: FetchedRaw[] = []
      let thrown = false
      try {
        const sig = state.controller.signal
        result = await connector.fetch(entry.task, handleFor(name, connector, sig), { secrets, signal: sig, now: iso() })
        failedRaws = result.raws
        // A challenge in any raw wins over the other failures.
        const found = result.raws.map((r) => classifyRaw(r, name === "browser")).filter((f): f is Failure => f !== undefined)
        failure = found.find((f) => f.challenge) ?? found.find((f) => f.cause === "challenge") ?? found[0]
        if (!failure && result.raws.length === 0) {
          failure = { fallback: true, challenge: false, cause: "empty", message: "no content" }
        }
      } catch (e) {
        if (aborted()) return // stays pending
        if (e instanceof MissingSecretError) {
          // This transport has no secret: try the next declared one, else skip with the secret's name.
          const next = state.transports[entry.attempt + 1]
          if (!next) return skip(entry, `missing_secret:${e.secret}`, "missing secret")
          entry.escalations.push({ from: name, to: next })
          await emit("escalation", { connector: connector.id, taskId: entry.task.id, from: name, to: next, cause: "missing_secret" })
          entry.attempt++
          enqueue(entry)
          return
        }
        failure = classifyError(e, name === "browser")
        // Aborted because another task of this connector met a challenge: skipped, not failed.
        if (state.stopped && !failure.challenge) return skip(entry, "challenge", "challenge")
        thrown = true
        if (e instanceof TransportError && e.url) {
          failedRaws = [{ url: e.url, ext: e.ext ?? "bin", bytes: e.body ?? new Uint8Array(), httpStatus: e.status }]
        }
      }

      const fetchedAt = iso()
      // Synchronous, before any await: nothing of this connector can start after this line.
      const firstHalt = failure?.challenge === true && !state.stopped
      const halted = failure?.challenge ? haltConnector(state) : []
      if (failure) {
        const f = failure
        await write(async () => {
          for (const raw of failedRaws) {
            await store.putRaw({
              connector: connector.id,
              ext: raw.ext,
              bytes: raw.bytes,
              url: raw.url,
              fetchedAt,
              httpStatus: raw.httpStatus,
              transport: name,
              runId,
              failure: thrown ? f.cause : (classifyRaw(raw, name === "browser")?.cause ?? f.cause),
            })
          }
        })
        if (f.challenge) {
          await finishFailed(entry, f)
          await skipHalted(state, halted, firstHalt)
          return
        }
        const next = state.transports[entry.attempt + 1]
        if (f.fallback && next) {
          entry.escalations.push({ from: name, to: next })
          await emit("escalation", { connector: connector.id, taskId: entry.task.id, from: name, to: next, cause: f.cause })
          entry.attempt++
          enqueue(entry)
          return
        }
        return finishFailed(entry, f)
      }

      // Success: keep the raws, parse and validate every one. The commit waits for its turn.
      const prepared: Prepared[] = []
      const tasks: Task[] = []
      const stored = await write(async () => {
        const out: Array<{ raw: FetchedRaw; ref: string; hash: string }> = []
        for (const raw of result!.raws) {
          const put = await store.putRaw({
            connector: connector.id,
            ext: raw.ext,
            bytes: raw.bytes,
            url: raw.url,
            fetchedAt,
            httpStatus: raw.httpStatus,
            transport: name,
            runId,
          })
          out.push({ raw, ref: put.ref, hash: put.hash })
        }
        return out
      })
      // Parsing and validation run outside the write queue: only sampling, dedup and writes are serialised.
      let parseError: string | undefined
      try {
        for (const { raw, ref, hash } of stored) {
          const parsed = await connector.parse({
            connector: connector.id,
            task: entry.task,
            raw: { ref, url: raw.url, ext: raw.ext, bytes: raw.bytes, httpStatus: raw.httpStatus, fetchedAt, transport: name },
          })
          prepared.push(await prepare(entry, parsed, ref, hash, fetchedAt, name))
        }
        for (const t of result!.tasks ?? []) tasks.push(CollectTask.parse(t))
      } catch (e) {
        parseError = e instanceof Error ? e.message : String(e)
      }
      if (parseError !== undefined) {
        return finishFailed(entry, { fallback: false, challenge: false, cause: "parse", message: parseError })
      }
      // The head of the order commits right away and keeps its worker. Any other task
      // gives its worker back and waits detached, so a later task can never hold the lane
      // an earlier one needs (a fallback into the browser lane, say).
      if (slots[0] === entry || !slots.includes(entry)) return commit(entry, prepared, tasks, name)
      commitsActive++
      const p: Promise<void> = commit(entry, prepared, tasks, name)
        .catch((e) => {
          if (stopping() && (e as { name?: string })?.name === "AbortError") return
          fatal ??= toError(e)
        })
        .finally(() => {
          active.delete(p)
          commitsActive--
          pump()
        })
      active.add(p)
    }

    /** Commit one task's outcome: sampling, dedup and writes, then `done`. Runs in `order`, never before an earlier slot resolves. */
    async function commit(entry: Entry, prepared: Prepared[], tasks: Task[], name: TransportName): Promise<void> {
      const connector = entry.connector
      const state = states.get(connector.id)!
      const wasHead = slots[0] === entry || !slots.includes(entry)
      if (!(await awaitTurn(entry))) return // stays pending
      const counters: TaskCounters = { items: 0, newItems: 0, duplicates: 0, observations: 0, metricValues: 0 }
      const followUps: Entry[] = []
      const outcome = { v: "done" as "done" | "stopped" | "bail" }
      await write(async () => {
        // State may have changed while this write waited in the queue. A failed store or a cancelled
        // run writes nothing more (a task that was already the head when the run was cancelled still
        // completes); a connector stopped by a challenge samples, writes and queues nothing.
        if (fatal !== undefined || (aborted() && !wasHead)) {
          outcome.v = "bail"
          return
        }
        if (state.stopped) {
          outcome.v = "stopped"
          return
        }
        await ingest(await sample(entry, prepared), counters)
        tasks.forEach((task, j) => {
          const k = key(connector.id, task.id)
          if (known.has(k)) return
          known.add(k)
          followUps.push(mkEntry(state, k, task, [...entry.order, j]))
        })
        // Follow-ups take their slots before the parent's slot is released.
        for (const f of followUps) {
          registerSlot(f)
          await store.appendTask(runId, {
            taskId: f.key,
            connector: connector.id,
            status: "pending",
            order: f.order,
            payload: payloadOf(f.task),
            updatedAt: iso(),
          })
        }
        await store.appendTask(runId, {
          taskId: entry.key,
          connector: connector.id,
          status: "done",
          transport: name,
          order: entry.order,
          payload: payloadOf(entry.task),
          escalations: entry.escalations,
          counters: { ...counters, durationMs: clock.now() - entry.t0 },
          updatedAt: iso(),
        })
      })
      if (outcome.v === "bail") return // stays pending
      if (outcome.v === "stopped") return skip(entry, "challenge", "challenge")
      resolveSlot(entry)
      for (const f of followUps) enqueue(f)
      await emit("task.end", {
        connector: connector.id,
        taskId: entry.task.id,
        status: "done",
        transport: name,
        durationMs: clock.now() - entry.t0,
        ...counters,
      })
    }

    pump()
    await finished
    await Promise.allSettled([...active])
    if (fatal !== undefined) {
      // Best effort: leave a report of what is on disk, then surface the failure.
      try {
        await write(async () => store.writeReport(runId, await buildReport(runId, recipe, startedAt, states)))
      } catch {
        // The store is what failed; the run error below says so.
      }
      throw new CollectRunError(runId, fatal)
    }
    if (aborted()) await emit("cancelled", {})
    const report = await buildReport(runId, recipe, startedAt, states)
    await emit("run.end", { connectors: report.connectors.map((c) => ({ connector: c.connector, status: c.status })) })
    await write(() => store.writeReport(runId, report))
    return report
  }

  /** The report is rebuilt from the task records, so it covers the whole run and survives a resume. */
  async function buildReport(runId: string, recipe: Recipe, startedAt: string, states: Map<string, ConnectorState>): Promise<RunReport> {
    const { records: tasks } = await readAll(store.tasks(runId))
    const samplingRows = recipe.sampling !== undefined ? (await readAll(store.sampling(runId))).records : []
    const coverage = await computeCoverage(
      store,
      [...states.values()].flatMap((s) => (s.connector ? [s.connector] : [])),
    )

    const connectors: ConnectorReport[] = []
    for (const s of states.values()) {
      const mine = tasks.filter((t) => t.connector === s.id)
      const count = (status: TaskRecord["status"]) => mine.filter((t) => t.status === status).length
      const done = count("done")
      const failedTasks = mine.filter((t) => t.status === "failed")
      const skipped = count("skipped")
      const pending = count("pending") + count("started")
      const failures: Partial<Record<FailureCause, number>> = {}
      for (const t of failedTasks) failures[t.cause ?? "other"] = (failures[t.cause ?? "other"] ?? 0) + 1

      const sum = { items: 0, newItems: 0, duplicates: 0, observations: 0, metricValues: 0, durationMs: 0 }
      const escalations = new Map<string, { from: string; to: string; count: number }>()
      for (const t of mine) {
        for (const k of Object.keys(sum) as Array<keyof typeof sum>) sum[k] += t.counters?.[k] ?? 0
        for (const e of t.escalations ?? []) {
          const ek = `${e.from}>${e.to}`
          const cur = escalations.get(ek) ?? { from: e.from, to: e.to, count: 0 }
          cur.count++
          escalations.set(ek, cur)
        }
      }

      const challenged = mine.some((t) => t.reason === "challenge")
      const missing = mine.find((t) => t.status === "skipped" && t.reason?.startsWith("missing_secret:"))
      let status: ConnectorReport["status"] = "ok"
      let reason: string | undefined
      let skippedReason = s.skipReason
      if (!skippedReason && missing && done === 0 && failedTasks.length === 0 && skipped === mine.length) skippedReason = missing.reason
      if (skippedReason) status = "skipped"
      else if (challenged) {
        status = done > 0 ? "partial" : "failed"
        reason = "challenge: the connector was stopped and its remaining tasks skipped"
      } else if (done === 0 && failedTasks.length > 0) {
        status = "failed"
        reason = "every task failed"
      } else if (done > 0 && sum.items === 0) {
        status = "failed"
        reason = "shape check: the run returned no items"
      } else if (done > 0 && (s.connector?.counters.length ?? 0) > 0 && sum.metricValues === 0) {
        status = "failed"
        reason = "shape check: every counter is missing"
      } else if (failedTasks.length > 0 || skipped > 0 || pending > 0) {
        status = "partial"
        reason =
          pending > 0
            ? "pending tasks remain"
            : failedTasks.length > 0
              ? `${failedTasks.length} task(s) failed`
              : `${skipped} task(s) skipped`
      }

      connectors.push({
        connector: s.id,
        status,
        ...(skippedReason ? { skippedReason } : {}),
        ...(reason ? { reason } : {}),
        tasks: { planned: mine.length, done, failed: failedTasks.length, skipped },
        newItems: sum.newItems,
        observations: sum.observations,
        duplicates: sum.duplicates,
        failures,
        escalations: [...escalations.values()],
        durationMs: sum.durationMs,
        ...(recipe.sampling !== undefined ? { sampled: sampledOf(samplingRows.filter((r) => r.connector === s.id)) } : {}),
        coverage: { cells: coverage.cells.filter((c) => c.platform === s.id) },
      })
    }
    return { runId, startedAt, finishedAt: iso(), connectors, coverage }
  }

  return {
    async run(recipeInput, runOptions = {}) {
      const recipe = Recipe.parse(recipeInput)
      const runId = runOptions.runId ?? `${iso().replace(/[-:]/g, "").replace(/\..*$/, "")}-${randomId(random)}`
      const { runId: _ignored, ...rest } = runOptions
      return execute(runId, recipe, "new", rest)
    },
    async resume(runId, runOptions = {}) {
      const run = await store.getRun(runId)
      if (!run) throw new Error(`unknown run ${runId}`)
      return execute(runId, run.recipe, "resume", runOptions)
    },
  }
}
