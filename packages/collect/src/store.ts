import { z } from "zod"
import { Actor, CollectItem, FailureCause, Observation, Pickup, Recipe, RunReport } from "./schemas"
import { sha256Hex } from "./ids"

/** One line of `raw/index.jsonl`: where a fetched body lives and how it was fetched. */
export const RawIndexEntry = z.object({
  /** Store-relative path of the stored body, `raw/<connector>/<yyyy-mm>/<sha256>.<ext>.gz`. */
  ref: z.string().min(1),
  connector: z.string().min(1),
  /** SHA-256 of the body bytes, lowercase hex. */
  hash: z.string().length(64),
  ext: z.string().min(1),
  bytes: z.number().int().nonnegative(),
  url: z.string(),
  fetchedAt: z.iso.datetime({ offset: true }),
  httpStatus: z.number().int().optional(),
  transport: z.string(),
  runId: z.string().optional(),
  /** Set when the fetch failed (403, empty page, ...). The body, if any, is still kept. */
  failure: FailureCause.optional(),
})
export type RawIndexEntry = z.infer<typeof RawIndexEntry>

/** One line of `plan.jsonl`: a root task of the run, written once and atomically before anything runs. */
export const PlanEntry = z.object({
  taskId: z.string().min(1),
  connector: z.string().min(1),
  order: z.array(z.number().int().nonnegative()),
  payload: z.record(z.string(), z.unknown()),
})
export type PlanEntry = z.infer<typeof PlanEntry>

export const TaskStatus = z.enum(["pending", "started", "done", "failed", "skipped"])
export type TaskStatus = z.infer<typeof TaskStatus>

/** One line of `tasks.jsonl`. The last line for a task id is its current state. */
export const TaskRecord = z.object({
  taskId: z.string().min(1),
  connector: z.string().min(1),
  status: TaskStatus,
  transport: z.string().optional(),
  reason: z.string().optional(),
  /** Why a failed task failed. */
  cause: FailureCause.optional(),
  /** Global start order: connector index in the recipe, plan index, then follow-up depth and index. */
  order: z.array(z.number().int().nonnegative()).optional(),
  /** What the task did, recorded with its `done` (or `failed`) state; the run report is rebuilt from these. */
  counters: z
    .object({
      items: z.number().int().nonnegative(),
      newItems: z.number().int().nonnegative(),
      duplicates: z.number().int().nonnegative(),
      observations: z.number().int().nonnegative(),
      metricValues: z.number().int().nonnegative(),
      durationMs: z.number().nonnegative(),
    })
    .optional(),
  /** Transport changes the task went through (`http` to `browser`). */
  escalations: z.array(z.object({ from: z.string(), to: z.string() })).optional(),
  /** The task as the connector planned it (`id`, `kind`, `params`), so a run can be resumed from its log alone. */
  payload: z.record(z.string(), z.unknown()).optional(),
  updatedAt: z.iso.datetime({ offset: true }),
})
export type TaskRecord = z.infer<typeof TaskRecord>

/** One line of `sampling.jsonl`: a candidate seen, and whether the sampling kept it. */
export const SamplingRecord = z.object({
  candidate: z.string().min(1),
  decision: z.enum(["kept", "dropped"]),
  /** Why a candidate was dropped: `band_quota`, `domain_cap`, `no_metric` or `out_of_bands`. */
  rule: z.string().optional(),
  /** Index of the counter band the candidate fell in. */
  band: z.number().int().nonnegative().optional(),
  /** Host the candidate counted against. */
  domain: z.string().optional(),
  seed: z.number().int().optional(),
  connector: z.string().optional(),
  taskId: z.string().optional(),
  at: z.iso.datetime({ offset: true }),
})
export type SamplingRecord = z.infer<typeof SamplingRecord>

/** One line of `events.jsonl`. */
export const EventRecord = z.object({
  at: z.iso.datetime({ offset: true }),
  type: z.string().min(1),
  data: z.record(z.string(), z.unknown()).optional(),
})
export type EventRecord = z.infer<typeof EventRecord>

/** Content of `runs/<runId>/recipe.json`: the recipe as it was when the run started, and its hash. */
export const RunRecord = z.object({
  runId: z.string().min(1),
  createdAt: z.iso.datetime({ offset: true }),
  recipeHash: z.string().length(64),
  recipe: Recipe,
})
export type RunRecord = z.infer<typeof RunRecord>

export interface PutRawInput {
  connector: string
  /** File extension without the dot, e.g. `json`, `html`. */
  ext: string
  bytes: Uint8Array
  url: string
  fetchedAt: string
  httpStatus?: number
  transport: string
  runId?: string
  failure?: FailureCause
}

export interface PutRawResult {
  ref: string
  hash: string
  /** False when a body with the same bytes already sat at the same path; the index line is still appended. */
  stored: boolean
}

/**
 * A streaming read. `skipped` counts the lines that were unreadable (not JSON,
 * or failing schema validation) and were left out; it is final once the
 * iteration is over and restarts at 0 on each new iteration.
 */
export interface Reader<T> extends AsyncIterable<T> {
  readonly skipped: number
}

export interface StoreLock {
  release(): Promise<void>
}

/** Where records are kept, as seen by the engine. Same contract for the memory and the disk store. */
export interface CollectStore {
  /** Version of the stored shapes this store holds (after any migration). */
  schemaVersion(): Promise<number>

  putRaw(input: PutRawInput): Promise<PutRawResult>
  getRaw(ref: string): Promise<Uint8Array | undefined>
  rawIndex(): Reader<RawIndexEntry>

  /** Insert or replace an item: the last write for an id wins. */
  upsertItem(item: CollectItem): Promise<void>
  getItem(id: string): Promise<CollectItem | undefined>
  /** Current version of each item. `source` is the prefix of the item id (`hn` for `hn:1`), which is also the file the item is kept in. */
  items(source?: string): Reader<CollectItem>

  /** Observations, actors: filed by the id prefix (`itemId` / `ref`), and `source` filters on that prefix. */
  appendObservation(observation: Observation): Promise<void>
  observations(source?: string): Reader<Observation>
  appendActor(actor: Actor): Promise<void>
  actors(source?: string): Reader<Actor>
  appendPickup(pickup: Pickup): Promise<void>
  pickups(): Reader<Pickup>

  /** Dedup keys, see `seenKey`. */
  seenHas(key: string): Promise<boolean>
  /** The item id that owns a key. `undefined` when the key is unknown or was recorded without an owner. */
  seenGet(key: string): Promise<string | undefined>
  /** Record a key. `itemId` is the item that owns it; adding an owner to a key that had none sets it, an existing owner is kept. */
  seenAdd(key: string, itemId?: string): Promise<void>
  seenKeys(): Promise<string[]>
  /** Recompute the seen keys, with their owners, from the stored items (current version of each). */
  rebuildSeenIndex(): Promise<void>

  createRun(runId: string, recipe: Recipe): Promise<RunRecord>
  getRun(runId: string): Promise<RunRecord | undefined>
  listRuns(): Promise<string[]>
  /** The run-log writers below throw when the run was not created. Append a task state; the last line for a task id is its current state. */
  appendTask(runId: string, task: TaskRecord): Promise<void>
  tasks(runId: string): Reader<TaskRecord>
  /** Write the whole root plan of a run in one atomic write. A second call replaces it. */
  writePlan(runId: string, plan: PlanEntry[]): Promise<void>
  readPlan(runId: string): Promise<PlanEntry[] | undefined>
  appendSampling(runId: string, record: SamplingRecord): Promise<void>
  sampling(runId: string): Reader<SamplingRecord>
  appendEvent(runId: string, event: EventRecord): Promise<void>
  events(runId: string): Reader<EventRecord>
  writeReport(runId: string, report: RunReport): Promise<void>
  readReport(runId: string): Promise<RunReport | undefined>

  /** Take the store-wide writer lock. Throws `StoreLockedError` when it is held. */
  acquireLock(): Promise<StoreLock>
}

export class StoreLockedError extends Error {
  readonly code = "STORE_LOCKED"
  constructor(
    message: string,
    readonly holder?: { pid: number; at: string; host?: string },
  ) {
    super(message)
    this.name = "StoreLockedError"
  }
}

/** The store was written by a newer version than this reader understands. */
export class StoreVersionError extends Error {
  readonly code = "STORE_VERSION"
  constructor(
    readonly found: number,
    readonly supported: number,
  ) {
    super(`store schema version ${found} is newer than the supported version ${supported}; upgrade @agentproto/collect`)
    this.name = "StoreVersionError"
  }
}

/**
 * Drop the copy a task writes again when it is redone after a crash: records
 * with a `recordKey` are kept once per key, the first write wins (a retry that
 * reads other values for the same raw and index is the same record); records
 * without one always pass. Two distinct readings with equal values have
 * different keys and are both kept.
 */
export function dropRedone<T>(source: Reader<T>, tag: (r: T) => string | undefined): Reader<T> {
  return {
    get skipped() {
      return source.skipped
    },
    async *[Symbol.asyncIterator]() {
      const seen = new Set<string>()
      for await (const r of source) {
        const k = tag(r)
        if (k !== undefined) {
          if (seen.has(k)) continue
          seen.add(k)
        }
        yield r
      }
    },
  }
}

/** Records without a `recordKey` (not written by the engine) are never dropped. */
export const observationRedoKey = (o: Observation) => o.recordKey
export const pickupRedoKey = (p: Pickup) => p.recordKey

/** Dedup key kinds. Keys are `<kind>:<value>`. */
export function seenKey(kind: "id" | "url" | "content", value: string): string {
  if (value.includes("\n") || value.includes("\t")) throw new Error("a seen key cannot contain a newline or a tab")
  return `${kind}:${value}`
}

/** The keys an item contributes to the seen index: native id, canonical URL, content id. */
export function itemSeenKeys(item: CollectItem): string[] {
  const keys = [seenKey("id", item.id)]
  if (item.canonicalUrl) keys.push(seenKey("url", item.canonicalUrl))
  if (item.contentId) keys.push(seenKey("content", item.contentId))
  return keys
}

const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/** Names that become a path segment (connector, source, run id, extension) are restricted to a safe alphabet. */
export function assertSafeName(kind: string, value: string): string {
  if (!SAFE_NAME.test(value) || value.includes("..")) {
    throw new Error(`invalid ${kind} "${value}": use letters, digits, ".", "_" and "-"`)
  }
  return value
}

/** Source prefix of an id or ref of the form `source:rest`. */
export function sourceOf(idOrRef: string): string {
  const i = idOrRef.indexOf(":")
  if (i <= 0) throw new Error(`"${idOrRef}" has no source prefix`)
  return assertSafeName("source", idOrRef.slice(0, i))
}

/** `yyyy-mm` (UTC) of a timestamp. */
export function monthOf(timestamp: string): string {
  return new Date(timestamp).toISOString().slice(0, 7)
}

export async function sha256Bytes(bytes: Uint8Array): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>)
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("")
}

/** JSON with object keys sorted, so equal values give equal text. */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`
  if (value && typeof value === "object") {
    const o = value as Record<string, unknown>
    return `{${Object.keys(o)
      .sort()
      .filter((k) => o[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`)
      .join(",")}}`
  }
  return JSON.stringify(value) ?? "null"
}

export async function recipeHash(recipe: Recipe): Promise<string> {
  return sha256Hex(stableStringify(recipe))
}

const RAW_REF = /^raw\/([A-Za-z0-9][A-Za-z0-9._-]*)\/(\d{4}-\d{2})\/([0-9a-f]{64})\.([A-Za-z0-9][A-Za-z0-9._-]*)\.gz$/

/** Strict parser of a raw ref. Throws on anything that is not exactly `raw/<connector>/<yyyy-mm>/<sha256>.<ext>.gz`. */
export function parseRawRef(ref: string): { connector: string; month: string; hash: string; ext: string } {
  const m = RAW_REF.exec(ref)
  if (!m || ref.includes("..") || ref.includes("\\")) throw new Error(`invalid raw ref "${ref}"`)
  return { connector: m[1]!, month: m[2]!, hash: m[3]!, ext: m[4]! }
}

/** Relative path of a stored raw body. */
export function rawRef(connector: string, fetchedAt: string, hash: string, ext: string): string {
  const ref = `raw/${assertSafeName("connector", connector)}/${monthOf(fetchedAt)}/${hash}.${assertSafeName("extension", ext)}.gz`
  parseRawRef(ref)
  return ref
}

/** Build a `Reader` from a generator that reports each skipped line through `onSkip`. */
export function makeReader<T>(gen: (onSkip: () => void) => AsyncGenerator<T>): Reader<T> {
  const r = {
    skipped: 0,
    [Symbol.asyncIterator]() {
      r.skipped = 0
      return gen(() => {
        r.skipped++
      })
    },
  }
  return r
}

/** Drain a reader into an array, with the skipped count. */
export async function readAll<T>(reader: Reader<T>): Promise<{ records: T[]; skipped: number }> {
  const records: T[] = []
  for await (const r of reader) records.push(r)
  return { records, skipped: reader.skipped }
}

/** Keep the last record of each key, in order of first appearance. */
export async function* lastWins<T>(source: AsyncIterable<T>, key: (r: T) => string): AsyncGenerator<T> {
  const m = new Map<string, T>()
  for await (const r of source) m.set(key(r), r)
  yield* m.values()
}
