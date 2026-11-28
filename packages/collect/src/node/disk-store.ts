import { randomBytes } from "node:crypto"
import { createReadStream } from "node:fs"
import { appendFile, mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises"
import { hostname } from "node:os"
import { dirname, join } from "node:path"
import { createInterface } from "node:readline"
import { gunzipSync, gzipSync } from "node:zlib"
import type { ZodType } from "zod"
import { Actor, CollectItem, Observation, Pickup, Recipe, RunReport } from "../schemas"
import {
  type CollectStore,
  EventRecord,
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
  itemSeenKeys,
  lastWins,
  makeReader,
  rawRef,
  recipeHash,
  sha256Bytes,
  sourceOf,
} from "../store"
import { STORE_SCHEMA_VERSION } from "../version"

/** Rewrites the store at `root` from schema version N to N + 1. */
export type StoreMigration = (ctx: { root: string }) => Promise<void>

export interface OpenStoreOptions {
  /** Migrations keyed by the version they start from: `{ 0: v0ToV1 }` moves a v0 store to v1. Chained up to the current version. */
  migrations?: Record<number, StoreMigration>
  /** Clock used for run and lock timestamps. */
  now?: () => string
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

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    // EPERM: the process exists but belongs to someone else.
    return (e as NodeJS.ErrnoException).code === "EPERM"
  }
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  )
}

async function writeAtomic(path: string, data: string | Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.${randomBytes(4).toString("hex")}.tmp`
  await writeFile(tmp, data)
  await rename(tmp, path)
}

async function readVersion(root: string): Promise<number | undefined> {
  let text: string
  try {
    text = await readFile(join(root, "collect.json"), "utf8")
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw e
  }
  const v = (JSON.parse(text) as { schemaVersion?: unknown }).schemaVersion
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0) {
    throw new StoreMigrationError(`${join(root, "collect.json")} has no valid schemaVersion`)
  }
  return v
}

async function writeVersion(root: string, version: number): Promise<void> {
  await writeAtomic(join(root, "collect.json"), `${JSON.stringify({ schemaVersion: version })}\n`)
}

/** Create a store at `path` (or open it when it already exists). */
export async function initStore(path: string, options: OpenStoreOptions = {}): Promise<CollectStore> {
  if ((await readVersion(path)) === undefined) {
    await mkdir(path, { recursive: true })
    await writeVersion(path, STORE_SCHEMA_VERSION)
  }
  return openStore(path, options)
}

/**
 * Open an existing store. A store with an older schema version is migrated
 * through `options.migrations` (and `collect.json` rewritten); a store with a
 * newer version is refused with `StoreVersionError`.
 */
export async function openStore(path: string, options: OpenStoreOptions = {}): Promise<CollectStore> {
  let version = await readVersion(path)
  if (version === undefined) throw new StoreNotFoundError(path)
  if (version > STORE_SCHEMA_VERSION) throw new StoreVersionError(version, STORE_SCHEMA_VERSION)
  while (version < STORE_SCHEMA_VERSION) {
    const step = options.migrations?.[version]
    if (!step) throw new StoreMigrationError(`no migration from store schema version ${version} to ${version + 1}`)
    await step({ root: path })
    version += 1
    await writeVersion(path, version)
  }
  const seen = new Set<string>()
  const store = new DiskStore(path, options.now ?? (() => new Date().toISOString()), seen)
  await store.loadSeen()
  return store
}

class DiskStore implements CollectStore {
  /** Appends of this process, run one after the other. */
  private queue: Promise<unknown> = Promise.resolve()
  private lockToken: string | undefined

  constructor(
    private readonly root: string,
    private readonly now: () => string,
    private readonly seen: Set<string>,
  ) {}

  private p(...parts: string[]): string {
    return join(this.root, ...parts)
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn)
    this.queue = run.catch(() => undefined)
    return run
  }

  private append(path: string, record: unknown): Promise<void> {
    return this.enqueue(async () => {
      await mkdir(dirname(path), { recursive: true })
      await appendFile(path, `${JSON.stringify(record)}\n`)
    })
  }

  private async drain(): Promise<void> {
    await this.queue
  }

  /** Stream the valid lines of a JSONL file; unreadable lines are counted, never thrown. */
  private lines<T>(path: string, schema: ZodType<T>): Reader<T> {
    const store = this
    return makeReader<T>(async function* (onSkip) {
      await store.drain()
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
    })
  }

  private multi<T>(dir: string, source: string | undefined, schema: ZodType<T>): Reader<T> {
    const self = this
    return makeReader<T>(async function* (onSkip) {
      await self.drain()
      const names =
        source !== undefined
          ? [`${assertSafeName("source", source)}.jsonl`]
          : (await readdir(self.p(dir)).catch(() => [] as string[])).filter((n) => n.endsWith(".jsonl")).sort()
      for (const name of names) {
        const r = self.lines(self.p(dir, name), schema)
        yield* r
        for (let i = 0; i < r.skipped; i++) onSkip()
      }
    })
  }

  async loadSeen(): Promise<void> {
    const path = this.p("seen.idx")
    if (!(await exists(path))) return
    for (const line of (await readFile(path, "utf8")).split("\n")) if (line) this.seen.add(line)
  }

  async schemaVersion(): Promise<number> {
    return (await readVersion(this.root)) ?? STORE_SCHEMA_VERSION
  }

  async putRaw(input: PutRawInput) {
    const hash = await sha256Bytes(input.bytes)
    const ref = rawRef(input.connector, input.fetchedAt, hash, input.ext)
    const entry = RawIndexEntry.parse({
      ref,
      connector: input.connector,
      hash,
      ext: input.ext,
      bytes: input.bytes.byteLength,
      url: input.url,
      fetchedAt: input.fetchedAt,
      httpStatus: input.httpStatus,
      transport: input.transport,
      runId: input.runId,
      failure: input.failure,
    })
    const stored = await this.enqueue(async () => {
      const path = this.p(ref)
      const isNew = !(await exists(path))
      if (isNew) await writeAtomic(path, gzipSync(input.bytes))
      await mkdir(this.p("raw"), { recursive: true })
      await appendFile(this.p("raw", "index.jsonl"), `${JSON.stringify(entry)}\n`)
      return isNew
    })
    return { ref, hash, stored }
  }

  async getRaw(ref: string) {
    if (!/^raw\/[^/]+\/\d{4}-\d{2}\/[0-9a-f]{64}\.[A-Za-z0-9._-]+\.gz$/.test(ref) || ref.includes("..")) {
      throw new Error(`invalid raw ref "${ref}"`)
    }
    await this.drain()
    try {
      return new Uint8Array(gunzipSync(await readFile(this.p(ref))))
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined
      throw e
    }
  }

  rawIndex() {
    return this.lines(this.p("raw", "index.jsonl"), RawIndexEntry)
  }

  async upsertItem(item: CollectItem) {
    const parsed = CollectItem.parse(item)
    await this.append(this.p("items", `${sourceOf(parsed.id)}.jsonl`), parsed)
  }

  async getItem(id: string) {
    let found: CollectItem | undefined
    for await (const i of this.items(sourceOf(id))) if (i.id === id) found = i
    return found
  }

  items(source?: string) {
    const self = this
    return makeReader<CollectItem>(async function* (onSkip) {
      const r = self.multi("items", source, CollectItem)
      yield* lastWins(r, (i) => i.id)
      for (let i = 0; i < r.skipped; i++) onSkip()
    })
  }

  async appendObservation(o: Observation) {
    const parsed = Observation.parse(o)
    await this.append(this.p("observations", `${sourceOf(parsed.itemId)}.jsonl`), parsed)
  }
  observations(source?: string) {
    return this.multi("observations", source, Observation)
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
    return this.lines(this.p("pickups.jsonl"), Pickup)
  }

  async seenHas(key: string) {
    return this.seen.has(key)
  }
  async seenAdd(key: string) {
    if (key.includes("\n")) throw new Error("a seen key cannot contain a newline")
    if (this.seen.has(key)) return
    this.seen.add(key)
    await this.enqueue(async () => appendFile(this.p("seen.idx"), `${key}\n`))
  }
  async seenKeys() {
    return [...this.seen]
  }
  async rebuildSeenIndex() {
    const keys = new Set<string>()
    for await (const item of this.items()) for (const k of itemSeenKeys(item)) keys.add(k)
    await this.enqueue(async () => {
      await writeAtomic(this.p("seen.idx"), [...keys].map((k) => `${k}\n`).join(""))
    })
    this.seen.clear()
    for (const k of keys) this.seen.add(k)
  }

  private runDir(runId: string) {
    return this.p("runs", assertSafeName("run id", runId))
  }

  async createRun(runId: string, recipe: Recipe): Promise<RunRecord> {
    const parsed = Recipe.parse(recipe)
    const record: RunRecord = { runId, createdAt: this.now(), recipeHash: await recipeHash(parsed), recipe: parsed }
    return this.enqueue(async () => {
      const dir = this.runDir(runId)
      if (await exists(join(dir, "recipe.json"))) throw new Error(`run ${runId} already exists`)
      await writeAtomic(join(dir, "recipe.json"), `${JSON.stringify(record, null, 2)}\n`)
      return record
    })
  }
  async getRun(runId: string) {
    await this.drain()
    try {
      return RunRecordSchema.parse(JSON.parse(await readFile(join(this.runDir(runId), "recipe.json"), "utf8")))
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined
      throw e
    }
  }
  async listRuns() {
    await this.drain()
    const names = await readdir(this.p("runs")).catch(() => [] as string[])
    const out: string[] = []
    for (const n of names.sort()) if (await exists(this.p("runs", n, "recipe.json"))) out.push(n)
    return out
  }
  async appendTask(runId: string, task: TaskRecord) {
    await this.append(join(this.runDir(runId), "tasks.jsonl"), TaskRecord.parse(task))
  }
  tasks(runId: string) {
    const self = this
    return makeReader<TaskRecord>(async function* (onSkip) {
      const r = self.lines(join(self.runDir(runId), "tasks.jsonl"), TaskRecord)
      yield* lastWins(r, (t) => t.taskId)
      for (let i = 0; i < r.skipped; i++) onSkip()
    })
  }
  async appendSampling(runId: string, r: SamplingRecord) {
    await this.append(join(this.runDir(runId), "sampling.jsonl"), SamplingRecord.parse(r))
  }
  sampling(runId: string) {
    return this.lines(join(this.runDir(runId), "sampling.jsonl"), SamplingRecord)
  }
  async appendEvent(runId: string, e: EventRecord) {
    await this.append(join(this.runDir(runId), "events.jsonl"), EventRecord.parse(e))
  }
  events(runId: string) {
    return this.lines(join(this.runDir(runId), "events.jsonl"), EventRecord)
  }
  async writeReport(runId: string, report: RunReport) {
    const parsed = RunReport.parse(report)
    await this.enqueue(() => writeAtomic(join(this.runDir(runId), "report.json"), `${JSON.stringify(parsed, null, 2)}\n`))
  }
  async readReport(runId: string) {
    await this.drain()
    try {
      return RunReport.parse(JSON.parse(await readFile(join(this.runDir(runId), "report.json"), "utf8")))
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined
      throw e
    }
  }

  /**
   * Lock file `collect.lock`, created with O_EXCL (`wx`) and holding
   * `{ pid, at, host, token }`. A second acquire fails with `StoreLockedError`.
   * A lock is stale when it was written on this host by a pid that no longer
   * exists; a stale lock is broken automatically (removed, then acquired once
   * more). A lock from another host, or an unreadable one, is never broken.
   */
  async acquireLock() {
    const path = this.p(LOCK_FILE)
    const record: LockRecord = { pid: process.pid, at: this.now(), host: hostname(), token: randomBytes(8).toString("hex") }
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const fh = await open(path, "wx")
        try {
          await fh.writeFile(JSON.stringify(record))
        } finally {
          await fh.close()
        }
        this.lockToken = record.token
        return {
          release: async () => {
            if (this.lockToken !== record.token) return
            this.lockToken = undefined
            const current = await readLock(path)
            if (current?.token === record.token) await rm(path, { force: true })
          },
        }
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e
        const holder = await readLock(path)
        const stale = holder !== undefined && holder.host === record.host && !pidAlive(holder.pid)
        if (stale && attempt === 0) {
          await rm(path, { force: true })
          continue
        }
        throw new StoreLockedError(
          holder ? `store is locked by pid ${holder.pid} since ${holder.at}` : "store is locked (unreadable lock file)",
          holder && { pid: holder.pid, at: holder.at, host: holder.host },
        )
      }
    }
    throw new StoreLockedError("store lock could not be acquired")
  }
}

async function readLock(path: string): Promise<LockRecord | undefined> {
  try {
    const v = JSON.parse(await readFile(path, "utf8")) as LockRecord
    return typeof v.pid === "number" ? v : undefined
  } catch {
    return undefined
  }
}
