import { randomBytes } from "node:crypto"
import { createReadStream } from "node:fs"
import { appendFile, link, mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises"
import { hostname } from "node:os"
import { dirname, join } from "node:path"
import { createInterface } from "node:readline"
import { gunzipSync, gzipSync } from "node:zlib"
import type { ZodType } from "zod"
import { Actor, CollectItem, Observation, Pickup, Recipe, RunReport } from "../schemas"
import {
  type CollectStore,
  EventRecord,
  type PlanEntry,
  PlanEntry as PlanEntrySchema,
  type PutRawInput,
  RawIndexEntry,
  type Reader,
  type RunRecord,
  RunRecord as RunRecordSchema,
  SamplingRecord,
  StoreLockedError,
  StoreVersionError,
  TaskRecord,
  assertSafeName,
  dropRedone,
  itemSeenKeys,
  observationRedoKey,
  pickupRedoKey,
  lastWins,
  makeReader,
  parseRawRef,
  rawRef,
  recipeHash,
  sha256Bytes,
  sourceOf,
} from "../store"
import { STORE_SCHEMA_VERSION } from "../version"

/**
 * Rewrites the store at `root` from schema version N to N + 1. It runs under
 * the store lock but may be interrupted (crash, kill) and run again on the
 * same store: write it so that running it twice is safe (idempotent).
 */
export type StoreMigration = (ctx: { root: string }) => Promise<void>

export interface OpenStoreOptions {
  /** Migrations keyed by the version they start from: `{ 0: v0ToV1 }` moves a v0 store to v1. Chained up to the current version, under the store lock. */
  migrations?: Record<number, StoreMigration>
  /** Clock used for run and lock timestamps. */
  now?: () => string
  /** Tells whether a process id is alive; used to detect a stale lock. Defaults to `process.kill(pid, 0)`. */
  pidAlive?: (pid: number) => boolean
}

export class StoreNotFoundError extends Error {
  readonly code = "STORE_NOT_FOUND"
  constructor(readonly path: string) {
    super(`no collect store at ${path} (missing collect.json); create it with initStore()`)
    this.name = "StoreNotFoundError"
  }
}

export class StoreMigrationError extends Error {
  readonly code = "STORE_MIGRATION"
  constructor(message: string) {
    super(message)
    this.name = "StoreMigrationError"
  }
}

const LOCK_FILE = "collect.lock"

interface LockRecord {
  pid: number
  at: string
  host: string
  token: string
}

function defaultPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    // EPERM: the process exists but belongs to someone else.
    return (e as NodeJS.ErrnoException).code === "EPERM"
  }
}

const isEnoent = (e: unknown) => (e as NodeJS.ErrnoException)?.code === "ENOENT"
const isEexist = (e: unknown) => (e as NodeJS.ErrnoException)?.code === "EEXIST"

/** Only a missing file counts as "does not exist"; any other error is raised. */
async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch (e) {
    if (isEnoent(e)) return false
    throw e
  }
}

async function readdirOrEmpty(path: string): Promise<string[]> {
  try {
    return await readdir(path)
  } catch (e) {
    if (isEnoent(e)) return []
    throw e
  }
}

async function readFileOrUndefined(path: string): Promise<Buffer | undefined> {
  try {
    return await readFile(path)
  } catch (e) {
    if (isEnoent(e)) return undefined
    throw e
  }
}

async function writeAtomic(path: string, data: string | Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.${randomBytes(4).toString("hex")}.tmp`
  await writeFile(tmp, data)
  await rename(tmp, path)
}

/** Create `path` with its content in one step, failing with EEXIST when it exists: write a tmp file, then hard-link it. */
async function createExclusive(path: string, data: string): Promise<boolean> {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.${randomBytes(6).toString("hex")}.tmp`
  await writeFile(tmp, data)
  try {
    await link(tmp, path)
    return true
  } catch (e) {
    if (isEexist(e)) return false
    throw e
  } finally {
    await rm(tmp, { force: true })
  }
}

/** True when the file exists, is not empty, and its last byte is not a newline (a torn append). */
async function hasTornTail(path: string): Promise<boolean> {
  let fh
  try {
    fh = await open(path, "r")
  } catch (e) {
    if (isEnoent(e)) return false
    throw e
  }
  try {
    const { size } = await fh.stat()
    if (size === 0) return false
    const buf = Buffer.alloc(1)
    await fh.read(buf, 0, 1, size - 1)
    return buf[0] !== 0x0a
  } finally {
    await fh.close()
  }
}

async function readVersion(root: string): Promise<number | undefined> {
  const file = join(root, "collect.json")
  const buf = await readFileOrUndefined(file)
  if (!buf) return undefined
  let v: unknown
  try {
    v = (JSON.parse(buf.toString("utf8")) as { schemaVersion?: unknown }).schemaVersion
  } catch {
    throw new StoreMigrationError(`${file} is not valid JSON`)
  }
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0) {
    throw new StoreMigrationError(`${file} has no valid schemaVersion`)
  }
  return v
}

async function writeVersion(root: string, version: number): Promise<void> {
  await writeAtomic(join(root, "collect.json"), `${JSON.stringify({ schemaVersion: version })}\n`)
}

/** Create a store at `path`, or open it when it already exists. Safe to call concurrently. */
export async function initStore(path: string, options: OpenStoreOptions = {}): Promise<CollectStore> {
  if ((await readVersion(path)) === undefined) {
    // Exclusive create: the loser of a race sees EEXIST and treats the store as already initialised.
    await createExclusive(join(path, "collect.json"), `${JSON.stringify({ schemaVersion: STORE_SCHEMA_VERSION })}\n`)
  }
  return openStore(path, options)
}

/**
 * Open an existing store. A store with a newer schema version is refused with
 * `StoreVersionError`. A store with an older one is migrated through
 * `options.migrations`, under the store lock (so it throws `StoreLockedError`
 * when another writer holds it); the version is read again once the lock is
 * held, and `collect.json` is rewritten after each step.
 */
export async function openStore(path: string, options: OpenStoreOptions = {}): Promise<CollectStore> {
  let version = await readVersion(path)
  if (version === undefined) throw new StoreNotFoundError(path)
  if (version > STORE_SCHEMA_VERSION) throw new StoreVersionError(version, STORE_SCHEMA_VERSION)
  const store = new DiskStore(path, options.now ?? (() => new Date().toISOString()), options.pidAlive ?? defaultPidAlive)
  if (version < STORE_SCHEMA_VERSION) {
    const lock = await store.lockOnly()
    try {
      version = await readVersion(path)
      if (version === undefined) throw new StoreNotFoundError(path)
      if (version > STORE_SCHEMA_VERSION) throw new StoreVersionError(version, STORE_SCHEMA_VERSION)
      while (version < STORE_SCHEMA_VERSION) {
        const step = options.migrations?.[version]
        if (!step) throw new StoreMigrationError(`no migration from store schema version ${version} to ${version + 1}`)
        await step({ root: path })
        version += 1
        await writeVersion(path, version)
      }
    } finally {
      await lock.release()
    }
  }
  await store.reloadSeen()
  return store
}

function seenText(m: Map<string, string | undefined>): string {
  return [...m].map(([k, v]) => `${v === undefined ? k : `${k}\t${v}`}\n`).join("")
}

class DiskStore implements CollectStore {
  /** Writes of this process, run one after the other. */
  private queue: Promise<unknown> = Promise.resolve()
  private lockToken: string | undefined
  /** Log files whose tail was checked for a torn line since this handle started. */
  private readonly tailChecked = new Set<string>()
  /** Dedup key to the id of the item that owns it (`undefined` for a line written without an owner). */
  private readonly seen = new Map<string, string | undefined>()

  constructor(
    private readonly root: string,
    private readonly now: () => string,
    private readonly pidAlive: (pid: number) => boolean,
  ) {}

  private p(...parts: string[]): string {
    return join(this.root, ...parts)
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn)
    this.queue = run.catch(() => undefined)
    return run
  }

  private async drain(): Promise<void> {
    await this.queue
  }

  /** Append one JSON line. Runs inside the queue. A torn tail left by a crash is closed with a newline first, so it stays one skipped line. */
  private async appendLine(path: string, text: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true })
    if (!this.tailChecked.has(path)) {
      if (await hasTornTail(path)) await appendFile(path, "\n")
      this.tailChecked.add(path)
    }
    await appendFile(path, `${text}\n`)
  }

  private append(path: string, record: unknown): Promise<void> {
    const text = JSON.stringify(record)
    return this.enqueue(() => this.appendLine(path, text))
  }

  /** Lines of a JSONL file as records. Unreadable lines are reported through `onSkip`. Does not wait for the queue. */
  private async *readLines<T>(path: string, schema: ZodType<T>, onSkip: () => void): AsyncGenerator<T> {
    if (!(await exists(path))) return
    const rl = createInterface({ input: createReadStream(path, { encoding: "utf8" }), crlfDelay: Infinity })
    for await (const line of rl) {
      if (line.trim() === "") continue
      let value: unknown
      try {
        value = JSON.parse(line)
      } catch {
        onSkip()
        continue
      }
      const parsed = schema.safeParse(value)
      if (parsed.success) yield parsed.data
      else onSkip()
    }
  }

  private lines<T>(path: string, schema: ZodType<T>): Reader<T> {
    const self = this
    return makeReader<T>(async function* (onSkip) {
      await self.drain()
      yield* self.readLines(path, schema, onSkip)
    })
  }

  private async *readMulti<T>(dir: string, source: string | undefined, schema: ZodType<T>, onSkip: () => void): AsyncGenerator<T> {
    const names =
      source !== undefined
        ? [`${assertSafeName("source", source)}.jsonl`]
        : (await readdirOrEmpty(this.p(dir))).filter((n) => n.endsWith(".jsonl")).sort()
    for (const name of names) yield* this.readLines(this.p(dir, name), schema, onSkip)
  }

  private multi<T>(dir: string, source: string | undefined, schema: ZodType<T>): Reader<T> {
    const self = this
    return makeReader<T>(async function* (onSkip) {
      await self.drain()
      yield* self.readMulti(dir, source, schema, onSkip)
    })
  }

  private async *readItems(source: string | undefined, onSkip: () => void): AsyncGenerator<CollectItem> {
    yield* lastWins(this.readMulti("items", source, CollectItem, onSkip), (i) => i.id)
  }

  /**
   * Replace the in-memory seen set with the content of `seen.idx`, streamed.
   * A last line without a newline is a torn append: it is ignored, and when we
   * hold the lock the file is rewritten without it. This differs on purpose from
   * the JSONL logs, where a torn line is skipped on read and closed with a
   * newline on append: a half-written key is a valid but wrong key, so it must
   * never count as seen. The cost is that a key whose only missing byte was the
   * newline is forgotten and may be added again (a spurious re-fetch, no corruption).
   */
  async reloadSeen(): Promise<void> {
    await this.enqueue(async () => {
      const path = this.p("seen.idx")
      const next = new Map<string, string | undefined>()
      const add = (line: string) => {
        // `key<TAB>itemId`; an older line carries only the key. A later line can add an owner, never change one.
        const tab = line.indexOf("\t")
        const key = tab < 0 ? line : line.slice(0, tab)
        const owner = tab < 0 ? undefined : line.slice(tab + 1) || undefined
        if (!next.has(key) || (next.get(key) === undefined && owner !== undefined)) next.set(key, owner)
      }
      const torn = await hasTornTail(path)
      if (await exists(path)) {
        const rl = createInterface({ input: createReadStream(path, { encoding: "utf8" }), crlfDelay: Infinity })
        let last: string | undefined
        for await (const line of rl) {
          if (last !== undefined && last !== "") add(last)
          last = line
        }
        if (last !== undefined && last !== "" && !torn) add(last)
      }
      if (torn && this.lockToken) await writeAtomic(path, seenText(next))
      this.seen.clear()
      for (const [k, v] of next) this.seen.set(k, v)
    })
  }

  async schemaVersion(): Promise<number> {
    return (await readVersion(this.root)) ?? STORE_SCHEMA_VERSION
  }

  async putRaw(input: PutRawInput) {
    const bytes = new Uint8Array(input.bytes)
    const hash = await sha256Bytes(bytes)
    const ref = rawRef(input.connector, input.fetchedAt, hash, input.ext)
    const entry = RawIndexEntry.parse({
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
    })
    const stored = await this.enqueue(async () => {
      const path = this.p(ref)
      let isNew = true
      const existing = await readFileOrUndefined(path)
      if (existing) {
        // Keep the file only when it really holds these bytes.
        try {
          isNew = (await sha256Bytes(new Uint8Array(gunzipSync(existing)))) !== hash
        } catch {
          isNew = true
        }
      }
      if (isNew) await writeAtomic(path, gzipSync(bytes))
      await this.appendLine(this.p("raw", "index.jsonl"), JSON.stringify(entry))
      return isNew
    })
    return { ref, hash, stored }
  }

  async getRaw(ref: string) {
    parseRawRef(ref)
    await this.drain()
    const buf = await readFileOrUndefined(this.p(ref))
    return buf && new Uint8Array(gunzipSync(buf))
  }

  rawIndex() {
    return this.lines(this.p("raw", "index.jsonl"), RawIndexEntry)
  }

  async upsertItem(item: CollectItem) {
    const parsed = CollectItem.parse(item)
    await this.append(this.p("items", `${sourceOf(parsed.id)}.jsonl`), parsed)
  }

  /** Streams the one source file and keeps the last match: no map of ids is built. */
  async getItem(id: string) {
    await this.drain()
    let found: CollectItem | undefined
    for await (const i of this.readLines(this.p("items", `${sourceOf(id)}.jsonl`), CollectItem, () => {})) {
      if (i.id === id) found = i
    }
    return found
  }

  /** Last line per id wins. The unique ids of the files read are buffered in a map; `compact` keeps files small. */
  items(source?: string) {
    const self = this
    return makeReader<CollectItem>(async function* (onSkip) {
      await self.drain()
      yield* self.readItems(source, onSkip)
    })
  }

  async appendObservation(o: Observation) {
    const parsed = Observation.parse(o)
    await this.append(this.p("observations", `${sourceOf(parsed.itemId)}.jsonl`), parsed)
  }
  observations(source?: string) {
    return dropRedone(this.multi("observations", source, Observation), observationRedoKey)
  }
  async appendActor(a: Actor) {
    const parsed = Actor.parse(a)
    await this.append(this.p("actors", `${sourceOf(parsed.ref)}.jsonl`), parsed)
  }
  actors(source?: string) {
    return this.multi("actors", source, Actor)
  }
  async appendPickup(p: Pickup) {
    await this.append(this.p("pickups.jsonl"), Pickup.parse(p))
  }
  pickups() {
    return dropRedone(this.lines(this.p("pickups.jsonl"), Pickup), pickupRedoKey)
  }

  async seenHas(key: string) {
    return this.seen.has(key)
  }
  /** Persisted first, then added to the in-memory set. */
  async seenGet(key: string) {
    return this.seen.get(key)
  }
  async seenAdd(key: string, itemId?: string) {
    if (key.includes("\n") || key.includes("\t")) throw new Error("a seen key cannot contain a newline or a tab")
    if (itemId !== undefined && (itemId.includes("\n") || itemId.includes("\t"))) {
      throw new Error("an item id cannot contain a newline or a tab")
    }
    await this.enqueue(async () => {
      if (this.seen.has(key) && (this.seen.get(key) !== undefined || itemId === undefined)) return
      await this.appendLine(this.p("seen.idx"), itemId === undefined ? key : `${key}\t${itemId}`)
      this.seen.set(key, itemId)
    })
  }
  async seenKeys() {
    await this.drain()
    return [...this.seen.keys()]
  }
  /** Runs entirely inside the write queue, reading the items without waiting on it. */
  async rebuildSeenIndex() {
    await this.enqueue(async () => {
      const keys = new Map<string, string | undefined>()
      for await (const item of this.readItems(undefined, () => {})) {
        for (const k of itemSeenKeys(item)) if (!keys.has(k)) keys.set(k, item.id)
      }
      await writeAtomic(this.p("seen.idx"), seenText(keys))
      this.tailChecked.delete(this.p("seen.idx"))
      this.seen.clear()
      for (const [k, v] of keys) this.seen.set(k, v)
    })
  }

  private runDir(runId: string) {
    return this.p("runs", assertSafeName("run id", runId))
  }

  async createRun(runId: string, recipe: Recipe): Promise<RunRecord> {
    const dir = this.runDir(runId)
    const parsed = Recipe.parse(recipe)
    const record: RunRecord = { runId, createdAt: this.now(), recipeHash: await recipeHash(parsed), recipe: parsed }
    return this.enqueue(async () => {
      if (!(await createExclusive(join(dir, "recipe.json"), `${JSON.stringify(record, null, 2)}\n`))) {
        throw new Error(`run ${runId} already exists`)
      }
      return record
    })
  }
  async getRun(runId: string) {
    await this.drain()
    const buf = await readFileOrUndefined(join(this.runDir(runId), "recipe.json"))
    return buf && RunRecordSchema.parse(JSON.parse(buf.toString("utf8")))
  }
  async listRuns() {
    await this.drain()
    const out: string[] = []
    for (const n of (await readdirOrEmpty(this.p("runs"))).sort()) if (await exists(this.p("runs", n, "recipe.json"))) out.push(n)
    return out
  }

  private appendRunLine(runId: string, file: string, record: unknown): Promise<void> {
    const dir = this.runDir(runId)
    const text = JSON.stringify(record)
    return this.enqueue(async () => {
      if (!(await exists(join(dir, "recipe.json")))) throw new Error(`unknown run ${runId}`)
      await this.appendLine(join(dir, file), text)
    })
  }
  async appendTask(runId: string, task: TaskRecord) {
    await this.appendRunLine(runId, "tasks.jsonl", TaskRecord.parse(task))
  }
  tasks(runId: string) {
    const self = this
    return makeReader<TaskRecord>(async function* (onSkip) {
      await self.drain()
      yield* lastWins(self.readLines(join(self.runDir(runId), "tasks.jsonl"), TaskRecord, onSkip), (t) => t.taskId)
    })
  }
  async writePlan(runId: string, plan: PlanEntry[]) {
    const text = plan.map((p) => `${JSON.stringify(PlanEntrySchema.parse(p))}\n`).join("")
    const dir = this.runDir(runId)
    await this.enqueue(async () => {
      if (!(await exists(join(dir, "recipe.json")))) throw new Error(`unknown run ${runId}`)
      await writeAtomic(join(dir, "plan.jsonl"), text)
    })
  }
  async readPlan(runId: string) {
    await this.drain()
    const buf = await readFileOrUndefined(join(this.runDir(runId), "plan.jsonl"))
    if (!buf) return undefined
    const out: PlanEntry[] = []
    for (const line of buf.toString("utf8").split("\n")) {
      if (line.trim() === "") continue
      out.push(PlanEntrySchema.parse(JSON.parse(line)))
    }
    return out
  }
  async appendSampling(runId: string, r: SamplingRecord) {
    await this.appendRunLine(runId, "sampling.jsonl", SamplingRecord.parse(r))
  }
  sampling(runId: string) {
    return this.lines(join(this.runDir(runId), "sampling.jsonl"), SamplingRecord)
  }
  async appendEvent(runId: string, e: EventRecord) {
    await this.appendRunLine(runId, "events.jsonl", EventRecord.parse(e))
  }
  events(runId: string) {
    return this.lines(join(this.runDir(runId), "events.jsonl"), EventRecord)
  }
  async writeReport(runId: string, report: RunReport) {
    const parsed = RunReport.parse(report)
    const dir = this.runDir(runId)
    await this.enqueue(async () => {
      if (!(await exists(join(dir, "recipe.json")))) throw new Error(`unknown run ${runId}`)
      await writeAtomic(join(dir, "report.json"), `${JSON.stringify(parsed, null, 2)}\n`)
    })
  }
  async readReport(runId: string) {
    await this.drain()
    const buf = await readFileOrUndefined(join(this.runDir(runId), "report.json"))
    return buf && RunReport.parse(JSON.parse(buf.toString("utf8")))
  }

  private async readLock(path: string): Promise<LockRecord | undefined> {
    const buf = await readFileOrUndefined(path)
    if (!buf) return undefined
    try {
      const v = JSON.parse(buf.toString("utf8")) as LockRecord
      return typeof v.pid === "number" && typeof v.token === "string" ? v : undefined
    } catch {
      return undefined
    }
  }

  /**
   * Take `collect.lock`. The file is created already holding its content
   * (`{ pid, at, host, token }`): a tmp file is written, then hard-linked to
   * `collect.lock`, so a lock file never exists empty and EEXIST means held. A
   * second acquire throws `StoreLockedError`.
   *
   * A lock is stale when it was written on this host by a pid that is not
   * alive (see `pidAlive`); a stale lock is broken automatically. To break it
   * the file is renamed to `collect.lock.stale-<token>`, which only one process
   * wins; the renamed file is read again and must still be that dead holder's
   * (same pid and token), otherwise it is linked back and the store is reported
   * as locked. A lock from another host, or an unreadable one, is never broken.
   */
  async lockOnly() {
    const path = this.p(LOCK_FILE)
    const record: LockRecord = { pid: process.pid, at: this.now(), host: hostname(), token: randomBytes(8).toString("hex") }
    const locked = (holder?: LockRecord) =>
      new StoreLockedError(
        holder ? `store is locked by pid ${holder.pid} since ${holder.at}` : "store is locked (unreadable lock file)",
        holder && { pid: holder.pid, at: holder.at, host: holder.host },
      )
    for (let attempt = 0; attempt < 5; attempt++) {
      if (await createExclusive(path, JSON.stringify(record))) {
        this.lockToken = record.token
        return {
          release: async () => {
            if (this.lockToken !== record.token) return
            this.lockToken = undefined
            const current = await this.readLock(path)
            if (current?.token === record.token) await rm(path, { force: true })
          },
        }
      }
      const holder = await this.readLock(path)
      if (!holder) {
        if (await exists(path)) throw locked()
        continue // it vanished: try again
      }
      if (holder.host !== record.host || this.pidAlive(holder.pid)) throw locked(holder)
      const grave = `${path}.stale-${record.token}`
      try {
        await rename(path, grave)
      } catch (e) {
        if (isEnoent(e)) continue // someone else broke it first
        throw e
      }
      const moved = await this.readLock(grave)
      if (moved && moved.pid === holder.pid && moved.token === holder.token) {
        await rm(grave, { force: true })
        continue
      }
      // The file was replaced between our read and our rename: put it back if the slot is still free.
      try {
        await link(grave, path)
      } catch (e) {
        if (!isEexist(e)) throw e
      }
      await rm(grave, { force: true })
      throw locked(moved)
    }
    throw new StoreLockedError("store lock could not be acquired")
  }

  /** Lock the store, then reload the seen index from disk so a handle opened before another writer wrote is correct. */
  async acquireLock() {
    const lock = await this.lockOnly()
    await this.reloadSeen()
    return lock
  }
}
