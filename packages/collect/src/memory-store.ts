import { Actor, CollectItem, Observation, Pickup, Recipe, RunReport } from "./schemas"
import { STORE_SCHEMA_VERSION } from "./version"
import {
  type CollectStore,
  type EventRecord,
  EventRecord as EventRecordSchema,
  type PutRawInput,
  type RawIndexEntry,
  RawIndexEntry as RawIndexEntrySchema,
  type RunRecord,
  type SamplingRecord,
  SamplingRecord as SamplingRecordSchema,
  StoreLockedError,
  type TaskRecord,
  TaskRecord as TaskRecordSchema,
  assertSafeName,
  parseRawRef,
  itemSeenKeys,
  lastWins,
  makeReader,
  rawRef,
  recipeHash,
  sha256Bytes,
  sourceOf,
} from "./store"

interface RunState {
  record: RunRecord
  tasks: TaskRecord[]
  sampling: SamplingRecord[]
  events: EventRecord[]
  report?: RunReport
}

function listReader<T>(rows: () => T[]) {
  return makeReader<T>(async function* () {
    for (const r of rows()) yield structuredClone(r)
  })
}

/** In-memory store: same behaviour as the disk store, nothing persisted. */
export function memoryStore(options: { now?: () => string } = {}): CollectStore {
  const now = options.now ?? (() => new Date().toISOString())
  const raws = new Map<string, Uint8Array>()
  const rawIndex: RawIndexEntry[] = []
  const items = new Map<string, CollectItem>()
  const observations: Observation[] = []
  const actors: Actor[] = []
  const pickups: Pickup[] = []
  const seen = new Set<string>()
  const runs = new Map<string, RunState>()
  let locked = false

  const run = (runId: string): RunState => {
    const s = runs.get(assertSafeName("run id", runId))
    if (!s) throw new Error(`unknown run ${runId}`)
    return s
  }
  const rows = <T>(runId: string, pick: (s: RunState) => T[]): T[] => {
    const s = runs.get(assertSafeName("run id", runId))
    return s ? pick(s) : []
  }
  const bySource = <T>(rows: T[], source: string | undefined, sourceFor: (r: T) => string) =>
    source === undefined ? rows : rows.filter((r) => sourceFor(r) === source)

  return {
    async schemaVersion() {
      return STORE_SCHEMA_VERSION
    },

    async putRaw(input: PutRawInput) {
      const bytes = new Uint8Array(input.bytes)
      const hash = await sha256Bytes(bytes)
      const ref = rawRef(input.connector, input.fetchedAt, hash, input.ext)
      const stored = !raws.has(ref)
      if (stored) raws.set(ref, bytes)
      rawIndex.push(
        RawIndexEntrySchema.parse({
          ref,
          connector: input.connector,
          hash,
          ext: input.ext,
          bytes: bytes.byteLength,
          url: input.url,
          fetchedAt: input.fetchedAt,
          httpStatus: input.httpStatus,
          transport: input.transport,
          runId: input.runId,
          failure: input.failure,
        }),
      )
      return { ref, hash, stored }
    },
    async getRaw(ref) {
      parseRawRef(ref)
      const b = raws.get(ref)
      return b && new Uint8Array(b)
    },
    rawIndex: () => listReader(() => rawIndex),

    async upsertItem(item) {
      const parsed = CollectItem.parse(item)
      sourceOf(parsed.id)
      items.set(parsed.id, parsed)
    },
    async getItem(id) {
      const i = items.get(id)
      return i && structuredClone(i)
    },
    items: (source) => listReader(() => bySource([...items.values()], source, (i) => sourceOf(i.id))),

    async appendObservation(o) {
      const parsed = Observation.parse(o)
      sourceOf(parsed.itemId)
      observations.push(parsed)
    },
    observations: (source) => listReader(() => bySource(observations, source, (o) => sourceOf(o.itemId))),
    async appendActor(a) {
      const parsed = Actor.parse(a)
      sourceOf(parsed.ref)
      actors.push(parsed)
    },
    actors: (source) => listReader(() => bySource(actors, source, (a) => sourceOf(a.ref))),
    async appendPickup(p) {
      pickups.push(Pickup.parse(p))
    },
    pickups: () => listReader(() => pickups),

    async seenHas(key) {
      return seen.has(key)
    },
    async seenAdd(key) {
      seen.add(key)
    },
    async seenKeys() {
      return [...seen]
    },
    async rebuildSeenIndex() {
      seen.clear()
      for (const item of items.values()) for (const k of itemSeenKeys(item)) seen.add(k)
    },

    async createRun(runId, recipe) {
      assertSafeName("run id", runId)
      const parsed = Recipe.parse(recipe)
      const hash = await recipeHash(parsed)
      // Check and insert with no await in between, so two concurrent creates cannot both pass.
      if (runs.has(runId)) throw new Error(`run ${runId} already exists`)
      const record: RunRecord = { runId, createdAt: now(), recipeHash: hash, recipe: parsed }
      runs.set(runId, { record, tasks: [], sampling: [], events: [] })
      return structuredClone(record)
    },
    async getRun(runId) {
      const r = runs.get(assertSafeName("run id", runId))
      return r && structuredClone(r.record)
    },
    async listRuns() {
      return [...runs.keys()].sort()
    },
    async appendTask(runId, task) {
      run(runId).tasks.push(TaskRecordSchema.parse(task))
    },
    tasks: (runId) =>
      makeReader<TaskRecord>(async function* () {
        yield* lastWins(listReader(() => rows(runId, (s) => s.tasks)), (t) => t.taskId)
      }),
    async appendSampling(runId, r) {
      run(runId).sampling.push(SamplingRecordSchema.parse(r))
    },
    sampling: (runId) => listReader(() => rows(runId, (s) => s.sampling)),
    async appendEvent(runId, e) {
      run(runId).events.push(EventRecordSchema.parse(e))
    },
    events: (runId) => listReader(() => rows(runId, (s) => s.events)),
    async writeReport(runId, report) {
      run(runId).report = RunReport.parse(report)
    },
    async readReport(runId) {
      const r = runs.get(assertSafeName("run id", runId))?.report
      return r && structuredClone(r)
    },

    async acquireLock() {
      if (locked) throw new StoreLockedError("store is locked by another writer")
      locked = true
      let released = false
      return {
        async release() {
          if (released) return
          released = true
          locked = false
        },
      }
    },
  }
}
