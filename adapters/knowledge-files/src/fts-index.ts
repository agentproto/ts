/**
 * Client side of the on-disk FTS5 index: opens the store of fts-store.ts in
 * a `worker_threads` worker (default) or inline, and talks to it with async
 * requests either way.
 *
 * Why a worker: `DatabaseSync` is synchronous. Inline, every insert batch
 * and every search runs on the daemon's main thread; in the worker the main
 * thread only posts messages, and the worker answers them one at a time, so
 * a query lands between two build batches instead of behind the whole build.
 * The worker is an `eval` worker built from `ftsStoreMain.toString()`, so
 * there is no second entry file for bundlers to lose.
 *
 * `node:sqlite` is loaded dynamically and may be missing (Node < 22.5, or
 * 22.5-22.12 without `--experimental-sqlite`), as may FTS5 in the linked
 * SQLite: {@link openFtsIndex} then rejects with {@link FtsUnavailableError}
 * and the adapter falls back to the in-memory index.
 *
 * One connection per index file per process: adapters that open the same
 * path share a refcounted handle.
 */

import { mkdir, rm, stat } from "node:fs/promises"
import path from "node:path"
import { Worker } from "node:worker_threads"
import { MAX_TOKEN_LEN, MIN_TOKEN_LEN, STOPWORD_LIST } from "./bm25.js"
import {
  FTS_SCHEMA_VERSION,
  ftsStoreMain,
  type FtsOp,
  type FtsOps,
  type FtsStore,
  type FtsStoreConfig,
  type SqliteModule,
} from "./fts-store.js"

/** The on-disk index cannot be used here: no `node:sqlite`, or no FTS5. */
export class FtsUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "FtsUnavailableError"
  }
}

export interface FtsIndexHandle {
  readonly path: string
  /** True when the store runs in a worker thread. */
  readonly inWorker: boolean
  request<K extends FtsOp>(op: K, args: FtsOps[K]["args"]): Promise<FtsOps[K]["result"]>
  /** Drop this user's reference; the last one closes the connection. */
  release(): Promise<void>
}

export interface OpenFtsIndexOptions {
  /** Absolute path of the SQLite file (its directory is created). */
  readonly path: string
  /** Run the store in a worker thread. Default true. */
  readonly worker?: boolean
  /** Told when an unreadable index file is deleted to be rebuilt. */
  readonly onReset?: (reason: string) => void
}

// esbuild (via tsup) strips the `node:` prefix from builtin imports, and
// `node:sqlite` has no unprefixed name. A computed specifier keeps the prefix
// (same trick as runtime's transcript-export.ts).
const NODE_SQLITE = "node:" + "sqlite"

interface Shared {
  refs: number
  handle: Promise<Transport>
}

const shared = new Map<string, Shared>()

interface Transport {
  readonly inWorker: boolean
  call(op: FtsOp, args: unknown): Promise<unknown>
  close(): Promise<void>
}

/** Open (or join) the index at `opts.path`. */
export async function openFtsIndex(opts: OpenFtsIndexOptions): Promise<FtsIndexHandle> {
  const key = path.resolve(opts.path)
  let entry = shared.get(key)
  if (!entry) {
    const handle = openTransport(key, opts.worker ?? true, opts.onReset)
    entry = { refs: 0, handle }
    shared.set(key, entry)
    handle.catch(() => {
      if (shared.get(key) === entry) shared.delete(key)
    })
  }
  entry.refs++
  let transport: Transport
  try {
    transport = await entry.handle
  } catch (err) {
    entry.refs--
    throw err
  }
  const owner = entry
  let released = false
  return {
    path: key,
    inWorker: transport.inWorker,
    request: (op, args) => transport.call(op, args) as never,
    async release() {
      if (released) return
      released = true
      owner.refs--
      if (owner.refs > 0) return
      if (shared.get(key) === owner) shared.delete(key)
      await transport.close()
    },
  }
}

async function openTransport(
  file: string,
  worker: boolean,
  onReset?: (reason: string) => void
): Promise<Transport> {
  await mkdir(path.dirname(file), { recursive: true })
  const config: FtsStoreConfig = {
    path: file,
    schemaVersion: FTS_SCHEMA_VERSION,
    stopwords: STOPWORD_LIST,
    minTokenLength: MIN_TOKEN_LEN,
    maxTokenLength: MAX_TOKEN_LEN,
  }
  const open = worker ? openWorker : openInline
  try {
    return await open(config)
  } catch (err) {
    if (err instanceof FtsUnavailableError) throw err
    // Derived data: a file SQLite cannot read is deleted and rebuilt, once.
    // A second failure, or any other error, is real and falls back.
    const message = err instanceof Error ? err.message : String(err)
    if (!CORRUPT_RE.test(message) || !(await exists(file))) throw err
    onReset?.(message)
    await removeIndexFiles(file)
    return await open(config)
  }
}

/** SQLite's words for a file it cannot use as a database. */
const CORRUPT_RE = /not a database|malformed|corrupt|encrypted/i

/** Delete the index file and its WAL / shared-memory companions. */
export async function removeIndexFiles(file: string): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    await rm(file + suffix, { force: true })
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file)
    return true
  } catch {
    return false
  }
}

/** Errors that mean "this runtime cannot host the index" rather than "this
 *  file is bad". */
function unavailableReason(message: string): string | null {
  if (/node:sqlite|No such built-in module|ERR_UNKNOWN_BUILTIN_MODULE/i.test(message)) {
    return `node:sqlite is not available in Node ${process.versions.node}`
  }
  if (/no such module: fts5|contentless_delete|no such module: fts5vocab/i.test(message)) {
    return `the SQLite linked into Node ${process.versions.node} lacks FTS5 (contentless_delete)`
  }
  return null
}

async function openInline(config: FtsStoreConfig): Promise<Transport> {
  let sqlite: SqliteModule
  try {
    sqlite = (await import(/* @vite-ignore */ NODE_SQLITE)) as SqliteModule
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw new FtsUnavailableError(unavailableReason(message) ?? message)
  }
  let store: FtsStore
  try {
    store = ftsStoreMain(sqlite, config)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const reason = unavailableReason(message)
    if (reason) throw new FtsUnavailableError(reason)
    throw err
  }
  return {
    inWorker: false,
    async call(op, args) {
      return store.handle(op, args as never)
    },
    async close() {
      store.handle("close", undefined)
    },
  }
}

/** Worker body: build the store, then answer `{ id, op, args }` messages in
 *  order. `ftsStoreMain` is self-contained, so its source runs as is. */
const WORKER_SOURCE = `
// A bundler running with keepNames wraps inner functions in __name(): make
// that a no-op so the stringified store still runs.
const __name = fn => fn
const { parentPort, workerData } = require("node:worker_threads")
let store = null
try {
  const sqlite = require("node:sqlite")
  store = (${ftsStoreMain.toString()})(sqlite, workerData)
  parentPort.postMessage({ ready: true })
} catch (err) {
  parentPort.postMessage({ ready: false, error: String((err && err.message) || err) })
}
parentPort.on("message", msg => {
  try {
    const value = store.handle(msg.op, msg.args)
    parentPort.postMessage({ id: msg.id, ok: true, value })
  } catch (err) {
    parentPort.postMessage({ id: msg.id, ok: false, error: String((err && err.message) || err) })
  }
})
`

async function openWorker(config: FtsStoreConfig): Promise<Transport> {
  let worker: Worker
  try {
    worker = new Worker(WORKER_SOURCE, { eval: true, workerData: config })
  } catch (err) {
    throw new FtsUnavailableError(
      `cannot start the index worker: ${err instanceof Error ? err.message : String(err)}`
    )
  }
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  let nextId = 1
  let dead: Error | null = null
  // Only keep the process alive while a request is waiting for its answer.
  const settle = () => {
    if (pending.size === 0) worker.unref()
  }

  await new Promise<void>((resolve, reject) => {
    const onFirst = (msg: { ready?: boolean; error?: string }) => {
      worker.off("error", onError)
      if (msg.ready) return resolve()
      void worker.terminate()
      const message = msg.error ?? "index worker failed to start"
      const reason = unavailableReason(message)
      reject(reason ? new FtsUnavailableError(reason) : new Error(message))
    }
    const onError = (err: Error) => {
      worker.off("message", onFirst)
      reject(new FtsUnavailableError(`index worker crashed on start: ${err.message}`))
    }
    worker.once("message", onFirst)
    worker.once("error", onError)
  })
  worker.unref()

  const failAll = (err: Error) => {
    dead = err
    for (const p of pending.values()) p.reject(err)
    pending.clear()
  }
  worker.on("message", (msg: { id: number; ok: boolean; value?: unknown; error?: string }) => {
    const p = pending.get(msg.id)
    if (!p) return
    pending.delete(msg.id)
    settle()
    if (msg.ok) p.resolve(msg.value)
    else p.reject(new Error(msg.error))
  })
  worker.on("error", (err: Error) => failAll(new Error(`index worker crashed: ${err.message}`)))
  worker.on("exit", code => {
    if (!dead) failAll(new Error(`index worker exited (code ${code})`))
  })

  const call = (op: FtsOp, args: unknown): Promise<unknown> => {
    if (dead) return Promise.reject(dead)
    const id = nextId++
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject })
      worker.ref()
      worker.postMessage({ id, op, args })
    })
  }

  return {
    inWorker: true,
    call,
    async close() {
      if (dead) return
      try {
        await call("close", undefined)
      } catch {
        // already gone
      }
      dead = new Error("index closed")
      await worker.terminate()
    },
  }
}
