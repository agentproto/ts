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
  type Coverage,
  type FailureCause,
  type MetricName,
  Observation,
  Pickup,
  Recipe,
  type RunReport,
} from "./schemas"
import {
  type CollectStore,
  type EventRecord,
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

export interface Collector {
  /** Plan the recipe and run it. Creates a new run. */
  run(recipe: Recipe | unknown, options?: RunOptions): Promise<RunReport>
  /**
   * Continue a run from its log. Reloads the frozen recipe and every task as
   * last recorded; `done` tasks are skipped and never fetched again, `pending`,
   * `failed` and `skipped` tasks are redone (a skipped task is re-checked
   * against the transports and secrets available now). The report covers the
   * whole run, earlier attempts included.
   */
  resume(runId: string, options?: Omit<RunOptions, "runId">): Promise<RunReport>
}

const FALLBACK_STATUSES = new Set([401, 403, 429])
const DEFAULT_WORKERS = 8

const key = (connector: string, taskId: string) => `${connector}/${taskId}`

interface Entry {
  key: string
  connector: Connector
  task: ReturnType<typeof CollectTask.parse>
  order: number[]
}

interface ConnectorState {
  id: string
  connector?: Connector
  transports: TransportName[]
  skipReason?: string
  started: number
  cap?: number
}

interface Failure {
  fallback: boolean
  cause: FailureCause
  message: string
}

function classifyError(e: unknown): Failure {
  if (e instanceof TransportError) {
    const message = e.message
    switch (e.cause) {
      case "blocked":
      case "challenge":
        return { fallback: true, cause: "blocked", message }
      case "empty":
        return { fallback: true, cause: "empty", message }
      case "network":
        return { fallback: false, cause: "network", message }
      case "http":
        return e.status !== undefined && FALLBACK_STATUSES.has(e.status)
          ? { fallback: true, cause: "blocked", message }
          : { fallback: false, cause: "other", message }
    }
  }
  return { fallback: false, cause: "other", message: e instanceof Error ? e.message : String(e) }
}

function classifyRaw(raw: FetchedRaw): Failure | undefined {
  if (raw.challenge) return { fallback: true, cause: "blocked", message: "challenge page" }
  const s = raw.httpStatus
  if (s !== undefined && FALLBACK_STATUSES.has(s)) return { fallback: true, cause: "blocked", message: `HTTP ${s}` }
  if (raw.bytes.byteLength === 0) return { fallback: true, cause: "empty", message: "empty content" }
  if (s !== undefined && s >= 500) return { fallback: false, cause: "network", message: `HTTP ${s}` }
  if (s !== undefined && s >= 400) return { fallback: false, cause: "other", message: `HTTP ${s}` }
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

interface TaskCounters {
  items: number
  newItems: number
  duplicates: number
  observations: number
  metricValues: number
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

  /** Wait for the host's turn: one request per interval per host, shared by every connector. */
  const nextSlot = new Map<string, number>()
  async function waitHost(url: string, intervalMs: number, signal?: AbortSignal) {
    if (intervalMs <= 0) return
    const host = hostOf(url)
    const now = clock.now()
    const slot = Math.max(now, nextSlot.get(host) ?? 0)
    nextSlot.set(host, slot + intervalMs)
    if (slot > now) await clock.sleep(slot - now, signal)
    if (signal?.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" })
  }

  /** One browser task at a time per browser transport. */
  let browserTail: Promise<unknown> = Promise.resolve()
  function withBrowserSlot<T>(fn: () => Promise<T>): Promise<T> {
    const p = browserTail.then(fn)
    browserTail = p.then(
      () => undefined,
      () => undefined,
    )
    return p
  }

  function handleFor(name: TransportName, connector: Connector, signal?: AbortSignal): FetchTransport {
    const delay = connector.pace.delayMs
    if (name === "browser") {
      const b = transports.browser as BrowserTransport
      return {
        name,
        browser: {
          open: async (url) => {
            await waitHost(url, delay, signal)
            return b.open(url)
          },
          evaluate: (p, s) => b.evaluate(p, s),
          fetchInPage: (p, r) => b.fetchInPage(p, r),
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
          await waitHost(req.url, delay, req.signal ?? signal)
          return h.request({ signal, ...req })
        },
      },
    }
  }

  async function connectorState(id: string, recipe: Recipe): Promise<ConnectorState> {
    const connector = registry.get(id)
    const state: ConnectorState = { id, connector, transports: [], started: 0 }
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
    try {
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

      const connectorIds = [...new Set(recipe.sources.map((s) => s.connector))]
      const states = new Map<string, ConnectorState>()
      for (const id of connectorIds) states.set(id, await connectorState(id, recipe))

      const known = new Set<string>()
      const entries: Entry[] = []
      const payloadOf = (t: Entry["task"]) => ({ id: t.id, ...(t.kind ? { kind: t.kind } : {}), params: t.params })

      if (mode === "new") {
        for (const id of connectorIds) {
          const state = states.get(id)!
          const sources: RecipeSource[] = recipe.sources.filter((s) => s.connector === id)
          if (!state.connector) {
            await emit("connector.skipped", { connector: id, reason: state.skipReason })
            continue
          }
          const planned = state.connector.plan(recipe, sources).map((t) => CollectTask.parse(t))
          let index = 0
          for (const task of planned) {
            const k = key(id, task.id)
            if (known.has(k)) continue
            known.add(k)
            const base = { taskId: k, connector: id, payload: payloadOf(task) }
            if (state.skipReason) {
              await record({ ...base, status: "skipped", reason: state.skipReason })
            } else {
              await record({ ...base, status: "pending" })
              entries.push({ key: k, connector: state.connector, task, order: [index] })
            }
            index++
          }
          if (state.skipReason) await emit("connector.skipped", { connector: id, reason: state.skipReason })
        }
      } else {
        const { records } = await readAll(store.tasks(runId))
        records.forEach((r, index) => {
          known.add(r.taskId)
          const state = states.get(r.connector)
          if (r.status === "done") {
            if (state) state.started++
            return
          }
          const task = CollectTask.safeParse(r.payload)
          if (!state?.connector || state.skipReason || !task.success) return
          entries.push({ key: r.taskId, connector: state.connector, task: task.data, order: [index] })
        })
        for (const state of states.values()) {
          if (state.skipReason) await emit("connector.skipped", { connector: state.id, reason: state.skipReason })
        }
      }

      // Scheduling.
      const workers = recipe.workers ?? DEFAULT_WORKERS
      const poolQueue: Entry[] = []
      const browserQueue: Entry[] = []
      const enqueue = (e: Entry) => {
        const first = states.get(e.connector.id)?.transports[0]
        insertSorted(first === "browser" ? browserQueue : poolQueue, e)
      }
      for (const e of entries) enqueue(e)
      let poolActive = 0
      let browserActive = 0
      let totalStarted = 0
      const aborted = () => signal?.aborted === true
      let finish: () => void = () => {}
      const finished = new Promise<void>((resolve) => {
        finish = resolve
      })
      const check = () => {
        if (poolActive === 0 && browserActive === 0 && (aborted() || (!poolQueue.length && !browserQueue.length))) {
          finish()
        }
      }
      const pump = () => {
        if (!aborted()) {
          while (poolActive < workers && poolQueue.length) launch(poolQueue.shift()!, "pool")
          if (browserActive === 0 && browserQueue.length) launch(browserQueue.shift()!, "browser")
        }
        check()
      }
      const launch = (entry: Entry, lane: "pool" | "browser") => {
        if (lane === "pool") poolActive++
        else browserActive++
        runTask(entry)
          .catch(async (e) => {
            await emit("error", { connector: entry.connector.id, taskId: entry.task.id, message: String(e) })
          })
          .finally(() => {
            if (lane === "pool") poolActive--
            else browserActive--
            pump()
          })
      }
      signal?.addEventListener("abort", check, { once: true })

      // Level 2 lookup: canonical URL to the item holding it.
      const urlIndex = new Map<string, string>()
      for await (const item of store.items()) if (item.canonicalUrl) urlIndex.set(item.canonicalUrl, item.id)
      const writtenActors = new Set<string>()

      async function ingest(
        entry: Entry,
        parsed: ParseResult,
        rawRef: string,
        fetchedAt: string,
        transport: TransportName,
        counters: TaskCounters,
      ) {
        const idMap = new Map<string, string>()
        const prepared: CollectItem[] = []
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
            rawRefs: [...new Set([...(p.rawRefs ?? []), rawRef])],
          })
          if (entry.connector.ext && item.ext !== undefined) entry.connector.ext.parse(item.ext)
          prepared.push(item)
        }
        const observations = (parsed.observations ?? []).map((o) =>
          Observation.parse({ measuredAt: fetchedAt, transport, runId, rawRef, ...o }),
        )
        const actors = (parsed.actors ?? []).map((a) => Actor.parse(a))
        const pickups = (parsed.pickups ?? []).map((p) =>
          Pickup.parse({
            firstSeenAt: fetchedAt,
            measuredAt: fetchedAt,
            runId,
            ...p,
            evidence: { rawRef, ...p.evidence },
          }),
        )

        // Validated: from here on, write.
        counters.items += prepared.length
        for (const item of prepared) {
          if (await store.seenHas(seenKey("id", item.id))) {
            counters.duplicates++
            idMap.set(item.id, item.id)
            continue
          }
          if (item.canonicalUrl && (await store.seenHas(seenKey("url", item.canonicalUrl)))) {
            counters.duplicates++
            const existing = urlIndex.get(item.canonicalUrl)
            if (existing) idMap.set(item.id, existing)
            continue
          }
          await store.upsertItem(item)
          for (const k of itemSeenKeys(item)) await store.seenAdd(k)
          if (item.canonicalUrl) urlIndex.set(item.canonicalUrl, item.id)
          counters.newItems++
        }
        for (const o of observations) {
          const itemId = idMap.get(o.itemId) ?? o.itemId
          await store.appendObservation({ ...o, itemId })
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
          await store.appendPickup({ ...p, itemId: idMap.get(p.itemId) ?? p.itemId })
        }
      }

      async function runTask(entry: Entry): Promise<void> {
        const connector = entry.connector
        const state = states.get(connector.id)!
        const base = { taskId: entry.key, connector: connector.id, payload: payloadOf(entry.task) }
        if (state.cap !== undefined && state.started >= state.cap) {
          await record({ ...base, status: "skipped", reason: `per-connector cap reached (${state.cap})` })
          await emit("task.skipped", { connector: connector.id, taskId: entry.task.id, reason: "cap" })
          return
        }
        if (recipe.caps?.total !== undefined && totalStarted >= recipe.caps.total) {
          await record({ ...base, status: "skipped", reason: `total cap reached (${recipe.caps.total})` })
          await emit("task.skipped", { connector: connector.id, taskId: entry.task.id, reason: "total cap" })
          return
        }
        state.started++
        totalStarted++
        const t0 = clock.now()
        await emit("task.start", { connector: connector.id, taskId: entry.task.id })

        let last: Failure = { fallback: false, cause: "other", message: "no transport tried" }
        for (let i = 0; i < state.transports.length; i++) {
          if (aborted()) return // stays pending
          const name = state.transports[i]!
          const attempt = async (): Promise<FetchResult> =>
            connector.fetch(entry.task, handleFor(name, connector, signal), { secrets, signal, now: iso() })
          let result: FetchResult | undefined
          let failure: Failure | undefined
          let failedRaws: FetchedRaw[] = []
          try {
            result = await (name === "browser" ? withBrowserSlot(attempt) : attempt())
            failedRaws = result.raws
            const bad = result.raws.map(classifyRaw).find((f) => f !== undefined)
            if (bad) failure = bad
            else if (result.raws.length === 0) failure = { fallback: true, cause: "empty", message: "no content" }
          } catch (e) {
            if (aborted()) return // stays pending
            failure = classifyError(e)
            if (e instanceof TransportError && e.url) {
              failedRaws = [{ url: e.url, ext: e.ext ?? "bin", bytes: e.body ?? new Uint8Array(), httpStatus: e.status }]
            }
          }

          const fetchedAt = iso()
          if (failure) {
            last = failure
            await write(async () => {
              for (const raw of failedRaws) {
                const cause = classifyRaw(raw)?.cause ?? failure.cause
                await store.putRaw({
                  connector: connector.id,
                  ext: raw.ext,
                  bytes: raw.bytes,
                  url: raw.url,
                  fetchedAt,
                  httpStatus: raw.httpStatus,
                  transport: name,
                  runId,
                  failure: cause,
                })
              }
            })
            const next = state.transports[i + 1]
            if (failure.fallback && next) {
              await emit("escalation", {
                connector: connector.id,
                taskId: entry.task.id,
                from: name,
                to: next,
                cause: failure.cause,
              })
              continue
            }
            break
          }

          // Success: store, parse, dedup, write, then mark done.
          const counters: TaskCounters = { items: 0, newItems: 0, duplicates: 0, observations: 0, metricValues: 0 }
          const outcome = await write(async () => {
            try {
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
              const parsedAll: Array<{ parsed: ParseResult; ref: string }> = []
              for (const { raw, ref } of stored) {
                const parsed = await connector.parse({
                  connector: connector.id,
                  task: entry.task,
                  raw: {
                    ref,
                    url: raw.url,
                    ext: raw.ext,
                    bytes: raw.bytes,
                    httpStatus: raw.httpStatus,
                    fetchedAt,
                    transport: name,
                  },
                })
                parsedAll.push({ parsed, ref })
              }
              const followUps: Entry["task"][] = []
              for (const t of result!.tasks ?? []) followUps.push(CollectTask.parse(t))
              for (const { parsed, ref } of parsedAll) {
                await ingest(entry, parsed, ref, fetchedAt, name, counters)
              }
              const added: Entry[] = []
              followUps.forEach((task, j) => {
                const k = key(connector.id, task.id)
                if (known.has(k)) return
                known.add(k)
                added.push({ key: k, connector, task, order: [...entry.order, j] })
              })
              for (const a of added) {
                await store.appendTask(runId, {
                  taskId: a.key,
                  connector: connector.id,
                  status: "pending",
                  payload: payloadOf(a.task),
                  updatedAt: iso(),
                })
              }
              await store.appendTask(runId, {
                ...base,
                status: "done",
                transport: name,
                updatedAt: iso(),
              })
              return { added } as const
            } catch (e) {
              const message = e instanceof Error ? e.message : String(e)
              await store.appendTask(runId, {
                ...base,
                status: "failed",
                transport: name,
                cause: "parse",
                reason: message,
                updatedAt: iso(),
              })
              return { error: message } as const
            }
          })
          const durationMs = clock.now() - t0
          if ("error" in outcome) {
            await emit("task.end", {
              connector: connector.id,
              taskId: entry.task.id,
              status: "failed",
              transport: name,
              cause: "parse",
              message: outcome.error,
              durationMs,
              ...zeroCounters,
            })
            return
          }
          for (const a of outcome.added) enqueue(a)
          await emit("task.end", {
            connector: connector.id,
            taskId: entry.task.id,
            status: "done",
            transport: name,
            durationMs,
            ...counters,
          })
          return
        }

        // Every transport failed.
        await record({
          ...base,
          status: "failed",
          transport: state.transports[state.transports.length - 1],
          cause: last.cause,
          reason: last.message,
        })
        await emit("task.end", {
          connector: connector.id,
          taskId: entry.task.id,
          status: "failed",
          cause: last.cause,
          message: last.message,
          durationMs: clock.now() - t0,
          ...zeroCounters,
        })
      }

      pump()
      await finished
      if (aborted()) await emit("cancelled", {})

      const report = await buildReport(runId, startedAt, states)
      await emit("run.end", { connectors: report.connectors.map((c) => ({ connector: c.connector, status: c.status })) })
      await write(() => store.writeReport(runId, report))
      return report
    } finally {
      await lock.release()
    }
  }

  const zeroCounters = { items: 0, newItems: 0, duplicates: 0, observations: 0, metricValues: 0 }

  async function buildReport(
    runId: string,
    startedAt: string,
    states: Map<string, ConnectorState>,
  ): Promise<RunReport> {
    const { records: tasks } = await readAll(store.tasks(runId))
    const { records: events } = await readAll(store.events(runId))
    const primary: Record<string, MetricName | undefined> = {}
    for (const s of states.values()) primary[s.id] = s.connector?.counters.find((c) => c.primary)?.name
    const coverage: Coverage = await computeCoverage(store, { primary })

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
      for (const e of events) {
        const d = e.data
        if (!d || d.connector !== s.id) continue
        if (e.type === "task.end") {
          for (const k of Object.keys(sum) as Array<keyof typeof sum>) sum[k] += Number(d[k] ?? 0)
        } else if (e.type === "escalation") {
          const ek = `${d.from}>${d.to}`
          const cur = escalations.get(ek) ?? { from: String(d.from), to: String(d.to), count: 0 }
          cur.count++
          escalations.set(ek, cur)
        }
      }

      let status: ConnectorReport["status"] = "ok"
      let reason: string | undefined
      if (s.skipReason) status = "skipped"
      else if (done === 0 && failedTasks.length > 0) {
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
