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
import { canonicalUrl, itemIdFromUrl, textFingerprint } from "./ids"
import {
  Actor,
  CollectItem,
  type ConnectorReport,
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
}

interface Failure {
  fallback: boolean
  /** A verification page: stop the connector, never bypass. */
  challenge: boolean
  cause: FailureCause
  message: string
}

function classifyError(e: unknown): Failure {
  if (e instanceof TransportError) {
    const message = e.message
    switch (e.cause) {
      case "challenge":
        return { fallback: false, challenge: true, cause: "blocked", message }
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
function classifyRaw(raw: FetchedRaw): Failure | undefined {
  if (raw.challenge) return { fallback: false, challenge: true, cause: "blocked", message: "challenge page" }
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
            await gate(r.url, delay, r.signal ?? signal)
            return b.fetchInPage(p, r)
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
          await gate(req.url, delay, req.signal ?? signal)
          return h.request({ signal, ...req })
        },
      },
    }
  }

  async function connectorState(id: string, recipe: Recipe): Promise<ConnectorState> {
    const connector = registry.get(id)
    const state: ConnectorState = { id, connector, transports: [], started: 0, stopped: false }
    if (!connector) {
      state.skipReason = `connector "${id}" is not registered`
      return state
    }
    state.cap = recipe.caps?.perConnector ?? connector.pace.maxTasksPerRun
    state.transports = connector.transports.filter((t) => transports[t] !== undefined)
    if (connector.access.level === "key") {
      const secret = await secrets.get(connector.access.secret)
      if (!secret) {
        state.skipReason = `missing secret "${connector.access.secret}"`
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
        try {
          onEvent?.({ ...event, runId })
        } catch {
          // A failing listener never breaks the run.
        }
      })
    const record = (r: Omit<TaskRecord, "updatedAt">) =>
      write(() => store.appendTask(runId, { ...r, updatedAt: iso() }))

    if (mode === "new") await store.createRun(runId, recipe)
    await emit("run.start", { mode, recipeName: recipe.name })
    if (recipe.sampling !== undefined) {
      await emit("warning", { message: "recipe.sampling is not implemented yet and is ignored" })
    }

    const connectorIds = [...new Set(recipe.sources.map((s) => s.connector))]
    const states = new Map<string, ConnectorState>()
    for (const id of connectorIds) states.set(id, await connectorState(id, recipe))
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

    if (mode === "new") {
      const plan: PlanEntry[] = []
      const records: Array<Omit<TaskRecord, "updatedAt">> = []
      connectorIds.forEach((id, ci) => {
        const state = states.get(id)!
        if (!state.connector) return
        const sources: RecipeSource[] = recipe.sources.filter((s) => s.connector === id)
        const planned = state.connector.plan(recipe, sources).map((t) => CollectTask.parse(t))
        let index = 0
        for (const task of planned) {
          const k = key(id, task.id)
          if (known.has(k)) continue
          known.add(k)
          const order = [ci, index++]
          plan.push({ taskId: k, connector: id, order, payload: payloadOf(task) })
          const base = { taskId: k, connector: id, order, payload: payloadOf(task) }
          if (state.skipReason) records.push({ ...base, status: "skipped", reason: state.skipReason })
          else {
            records.push({ ...base, status: "pending" })
            entries.push(mkEntry(state, k, task, order))
          }
        }
      })
      // The whole root plan lands in one atomic write, before anything runs.
      await write(() => store.writePlan(runId, plan))
      for (const r of records) await record(r)
      for (const st of states.values()) {
        if (st.skipReason) await emit("connector.skipped", { connector: st.id, reason: st.skipReason })
      }
    } else {
      const plan = (await store.readPlan(runId)) ?? []
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
        if (status === "done" || status === "failed") {
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
    for (const e of entries) enqueue(e)
    let poolActive = 0
    let browserActive = 0
    let totalStarted = counted.size
    let fatal: unknown
    const aborted = () => signal?.aborted === true
    const stopping = () => aborted() || fatal !== undefined
    let finish: () => void = () => {}
    const finished = new Promise<void>((resolve) => {
      finish = resolve
    })
    const check = () => {
      if (poolActive === 0 && browserActive === 0 && (stopping() || (!poolQueue.length && !browserQueue.length))) finish()
    }
    const pump = () => {
      if (!stopping()) {
        while (poolActive < workers && poolQueue.length) launch(poolQueue.shift()!, "pool")
        if (browserActive === 0 && browserQueue.length) launch(browserQueue.shift()!, "browser")
      }
      check()
    }
    const launch = (entry: Entry, lane: "pool" | "browser") => {
      if (lane === "pool") poolActive++
      else browserActive++
      const p: Promise<void> = attempt(entry)
        .catch((e) => {
          if (stopping() && (e as { name?: string })?.name === "AbortError") return
          fatal ??= e
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
    }

    /** A challenge stops the connector: its queued tasks are skipped with reason `challenge`. */
    async function stopConnector(state: ConnectorState) {
      state.stopped = true
      await emit("connector.stopped", { connector: state.id, reason: "challenge" })
      for (const q of [poolQueue, browserQueue]) {
        for (let i = q.length - 1; i >= 0; i--) {
          if (q[i]!.connector.id === state.id) {
            const [e] = q.splice(i, 1)
            await skip(e!, "challenge", "challenge")
          }
        }
      }
    }

    async function prepare(
      entry: Entry,
      parsed: ParseResult,
      ref: string,
      fetchedAt: string,
      transport: TransportName,
    ): Promise<Prepared> {
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
      return {
        ref,
        items,
        observations: (parsed.observations ?? []).map((o) =>
          Observation.parse({ measuredAt: fetchedAt, transport, rawRef: ref, ...o, runId, taskId: entry.key }),
        ),
        actors: (parsed.actors ?? []).map((a) => Actor.parse(a)),
        pickups: (parsed.pickups ?? []).map((p) =>
          Pickup.parse({
            firstSeenAt: fetchedAt,
            measuredAt: fetchedAt,
            ...p,
            runId,
            taskId: entry.key,
            evidence: { rawRef: ref, ...p.evidence },
          }),
        ),
      }
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
      try {
        result = await connector.fetch(entry.task, handleFor(name, connector, signal), { secrets, signal, now: iso() })
        failedRaws = result.raws
        failure = result.raws.map(classifyRaw).find((f) => f !== undefined)
        if (!failure && result.raws.length === 0) {
          failure = { fallback: true, challenge: false, cause: "empty", message: "no content" }
        }
      } catch (e) {
        if (aborted()) return // stays pending
        failure = classifyError(e)
        if (e instanceof TransportError && e.url) {
          failedRaws = [{ url: e.url, ext: e.ext ?? "bin", bytes: e.body ?? new Uint8Array(), httpStatus: e.status }]
        }
      }

      const fetchedAt = iso()
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
              failure: classifyRaw(raw)?.cause ?? f.cause,
            })
          }
        })
        if (f.challenge) {
          await finishFailed(entry, f)
          await stopConnector(state)
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

      // Success: keep the raws, parse and validate every one, then write, then mark done.
      const counters: TaskCounters = { items: 0, newItems: 0, duplicates: 0, observations: 0, metricValues: 0 }
      let followUps: Entry[] = []
      const parseError = await write(async (): Promise<string | undefined> => {
        const stored: Array<{ raw: FetchedRaw; ref: string }> = []
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
          stored.push({ raw, ref: put.ref })
        }
        const prepared: Prepared[] = []
        const tasks: Task[] = []
        try {
          for (const { raw, ref } of stored) {
            const parsed = await connector.parse({
              connector: connector.id,
              task: entry.task,
              raw: { ref, url: raw.url, ext: raw.ext, bytes: raw.bytes, httpStatus: raw.httpStatus, fetchedAt, transport: name },
            })
            prepared.push(await prepare(entry, parsed, ref, fetchedAt, name))
          }
          for (const t of result!.tasks ?? []) tasks.push(CollectTask.parse(t))
        } catch (e) {
          return e instanceof Error ? e.message : String(e)
        }
        // Everything is valid: from here on, write.
        await ingest(prepared, counters)
        tasks.forEach((task, j) => {
          const k = key(connector.id, task.id)
          if (known.has(k)) return
          known.add(k)
          followUps.push(mkEntry(state, k, task, [...entry.order, j]))
        })
        for (const f of followUps) {
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
        return undefined
      })
      if (parseError !== undefined) {
        return finishFailed(entry, { fallback: false, challenge: false, cause: "parse", message: parseError })
      }
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
        await write(async () => store.writeReport(runId, await buildReport(runId, startedAt, states)))
      } catch {
        // The store is what failed; the run error below says so.
      }
      throw new CollectRunError(runId, fatal)
    }
    if (aborted()) await emit("cancelled", {})
    const report = await buildReport(runId, startedAt, states)
    await emit("run.end", { connectors: report.connectors.map((c) => ({ connector: c.connector, status: c.status })) })
    await write(() => store.writeReport(runId, report))
    return report
  }

  /** The report is rebuilt from the task records, so it covers the whole run and survives a resume. */
  async function buildReport(runId: string, startedAt: string, states: Map<string, ConnectorState>): Promise<RunReport> {
    const { records: tasks } = await readAll(store.tasks(runId))
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
      const pending = count("pending")
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
      let status: ConnectorReport["status"] = "ok"
      let reason: string | undefined
      if (s.skipReason) status = "skipped"
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
        reason = pending > 0 ? "pending tasks remain" : undefined
      }

      connectors.push({
        connector: s.id,
        status,
        ...(s.skipReason ? { skippedReason: s.skipReason } : {}),
        ...(reason ? { reason } : {}),
        tasks: { planned: mine.length, done, failed: failedTasks.length, skipped },
        newItems: sum.newItems,
        observations: sum.observations,
        duplicates: sum.duplicates,
        failures,
        escalations: [...escalations.values()],
        durationMs: sum.durationMs,
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
