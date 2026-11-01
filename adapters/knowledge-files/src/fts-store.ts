/**
 * The on-disk search index store: SQLite FTS5 through `node:sqlite`.
 *
 * {@link ftsStoreMain} is the whole store, written as ONE self-contained
 * function: it touches nothing but its two arguments and language globals.
 * That lets the same code run two ways without a second file to ship or
 * resolve: in a `worker_threads` worker (fts-index.ts stringifies it into an
 * `eval` worker, so `DatabaseSync` never blocks the daemon's main thread), or
 * inline on the calling thread. Keep it that way: no imports, no references
 * to module-level names, no helpers defined outside it.
 *
 * The FTS column holds PRE-TOKENIZED text: each doc is run through the same
 * tokenizer as the in-memory BM25 engine (bm25.ts: lowercase, split on non
 * `[a-z0-9]`, length 2-32, stopwords, frontmatter stripped) and stored as the
 * tokens joined by spaces, under FTS5's `ascii` tokenizer, which splits that
 * text back into exactly those tokens. Doc lengths, document frequencies and
 * term frequencies therefore match the in-memory engine one for one. The
 * table is contentless (`content=''`) with `contentless_delete=1`: only the
 * postings are stored, rows can still be deleted and replaced.
 *
 * The file is derived data. `docs` is the manifest (path, size, mtime per
 * indexed file) used to reconcile against the brain with a stat-only scan;
 * `meta.version` pins the schema AND the tokenizer, so a change to either
 * drops every table and rebuilds.
 */

/** Bump when the tables or the stored token format change. */
export const FTS_SCHEMA_VERSION = 1

export interface FtsStoreConfig {
  /** Absolute path of the SQLite file. */
  readonly path: string
  /** {@link FTS_SCHEMA_VERSION}, passed in so the store stays self-contained. */
  readonly schemaVersion: number
  readonly stopwords: readonly string[]
  readonly minTokenLength: number
  readonly maxTokenLength: number
}

/**
 * Every file the stat-only scan found, packed so posting it to the worker is
 * a few memcpys instead of a clone of 200k small arrays: paths joined with
 * NUL (which no file name contains), sizes and mtimes (whole ms) by position.
 */
export interface FtsManifest {
  readonly paths: string
  readonly sizes: Float64Array
  readonly mtimes: Float64Array
}

/** Separator of {@link FtsManifest.paths}. */
export const FTS_MANIFEST_SEP = "\u0000"

export interface FtsUpsertDoc {
  readonly path: string
  readonly size: number
  readonly mtimeMs: number
  /** Whole file content; "" records the file as empty (not searchable). */
  readonly text: string
}

export interface FtsInfo {
  /** Searchable docs (non-empty files). */
  readonly docs: number
  /** True once a full build finished; false while the first build runs. */
  readonly complete: boolean
  /** Why the tables were (re)created on open, or null when reused. */
  readonly created: "new" | "version" | null
  /** SQLite library version, for the logs. */
  readonly sqliteVersion: string
}

export interface FtsDiff {
  /** Manifest positions of the files that are new or whose size / mtime
   *  changed: read and upsert them. */
  readonly changed: Uint32Array
  /** Rows dropped because their file is gone. */
  readonly removed: number
  readonly unchanged: number
}

export interface FtsCandidate {
  readonly path: string
  /** `-bm25()` from FTS5 (k1 1.2, b 0.75): only used to pick candidates. */
  readonly ftsScore: number
}

export interface FtsSearchResult {
  readonly candidates: readonly FtsCandidate[]
  /** Searchable docs and their mean token length, for exact BM25. */
  readonly docs: number
  readonly avgDocLength: number
  /** Document frequency of each distinct query token. */
  readonly df: Readonly<Record<string, number>>
}

/** Operations the store answers, keyed by name, with their args and result. */
export interface FtsOps {
  info: { args: undefined; result: FtsInfo }
  mark: { args: undefined; result: number }
  diff: { args: { manifest: FtsManifest; mark: number }; result: FtsDiff }
  upsert: { args: { docs: readonly FtsUpsertDoc[] }; result: { added: number; updated: number } }
  remove: { args: { paths: readonly string[] }; result: { removed: number } }
  setComplete: { args: { complete: boolean }; result: null }
  search: { args: { tokens: readonly string[]; limit: number }; result: FtsSearchResult }
  list: { args: undefined; result: readonly string[] }
  has: { args: { path: string }; result: boolean }
  tokenize: { args: { text: string }; result: readonly string[] }
  close: { args: undefined; result: null }
}

export type FtsOp = keyof FtsOps

export interface FtsStore {
  handle<K extends FtsOp>(op: K, args: FtsOps[K]["args"]): FtsOps[K]["result"]
}

/** The `node:sqlite` surface the store uses. */
export interface SqliteModule {
  readonly DatabaseSync: new (path: string) => SqliteDb
}

interface SqliteStatement {
  run(...params: unknown[]): unknown
  get(...params: unknown[]): Record<string, unknown> | undefined
  all(...params: unknown[]): Array<Record<string, unknown>>
}

interface SqliteDb {
  exec(sql: string): void
  prepare(sql: string): SqliteStatement
  close(): void
}

/**
 * Open (or create) the store at `config.path` and return its op handler.
 * Throws when the file cannot be opened as SQLite or FTS5 is missing.
 * SELF-CONTAINED: see the module comment before touching it.
 */
export function ftsStoreMain(sqlite: SqliteModule, config: FtsStoreConfig): FtsStore {
  const stop = new Set(config.stopwords)
  const minLen = config.minTokenLength
  const maxLen = config.maxTokenLength
  const version = `${config.schemaVersion}|${minLen}|${maxLen}|${config.stopwords.join(",")}`

  function tokenize(text: string): string[] {
    let body = text
    if (body.startsWith("---")) {
      const end = body.indexOf("\n---", 3)
      if (end !== -1) body = body.slice(end + 4)
    }
    const out: string[] = []
    for (const raw of body.toLowerCase().split(/[^a-z0-9]+/)) {
      if (raw.length < minLen || raw.length > maxLen) continue
      if (stop.has(raw)) continue
      out.push(raw)
    }
    return out
  }

  const db = new sqlite.DatabaseSync(config.path)
  db.exec("PRAGMA journal_mode = WAL")
  db.exec("PRAGMA synchronous = NORMAL")
  db.exec("PRAGMA busy_timeout = 5000")
  db.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)")

  const metaGet = db.prepare("SELECT value FROM meta WHERE key = ?")
  const metaSet = db.prepare(
    "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  )
  const stored = metaGet.get("version")?.value
  let created: "new" | "version" | null = null
  if (stored !== version) {
    created = stored === undefined ? "new" : "version"
    db.exec("DROP TABLE IF EXISTS fts_row")
    db.exec("DROP TABLE IF EXISTS fts")
    db.exec("DROP TABLE IF EXISTS docs")
    db.exec(
      "CREATE TABLE docs (rowid INTEGER PRIMARY KEY, path TEXT NOT NULL UNIQUE, " +
        "size INTEGER NOT NULL, mtime INTEGER NOT NULL, len INTEGER NOT NULL, " +
        "has_text INTEGER NOT NULL, written INTEGER NOT NULL)"
    )
    // detail=full: bm25() needs per-row token counts, which the lighter
    // detail modes do not keep.
    db.exec(
      "CREATE VIRTUAL TABLE fts USING fts5(body, content='', contentless_delete=1, " +
        "tokenize='ascii', detail=full)"
    )
    db.exec("CREATE VIRTUAL TABLE fts_row USING fts5vocab(fts, 'row')")
    metaSet.run("version", version)
    metaSet.run("complete", "0")
  }

  const selectDoc = db.prepare("SELECT rowid, has_text FROM docs WHERE path = ?")
  const insertDoc = db.prepare(
    "INSERT INTO docs (path, size, mtime, len, has_text, written) VALUES (?, ?, ?, ?, ?, ?)"
  )
  const updateDoc = db.prepare(
    "UPDATE docs SET size = ?, mtime = ?, len = ?, has_text = ?, written = ? WHERE rowid = ?"
  )
  const deleteDoc = db.prepare("DELETE FROM docs WHERE rowid = ?")
  const insertFts = db.prepare("INSERT INTO fts (rowid, body) VALUES (?, ?)")
  const deleteFts = db.prepare("DELETE FROM fts WHERE rowid = ?")
  const allDocs = db.prepare("SELECT rowid, path, size, mtime, has_text, written FROM docs")
  const statsStmt = db.prepare(
    "SELECT count(*) AS n, coalesce(sum(len), 0) AS total FROM docs WHERE has_text = 1"
  )
  const dfStmt = db.prepare("SELECT doc FROM fts_row WHERE term = ?")
  const searchStmt = db.prepare(
    "SELECT rowid, bm25(fts) AS s FROM fts WHERE fts MATCH ? ORDER BY s, rowid LIMIT ?"
  )
  const pathOf = db.prepare("SELECT path FROM docs WHERE rowid = ?")
  const listStmt = db.prepare("SELECT path FROM docs WHERE has_text = 1 ORDER BY rowid")
  const sqliteVersion = String(db.prepare("SELECT sqlite_version() AS v").get()?.v ?? "?")

  // Searchable doc count and total length: recounted lazily after a write.
  let stats: { n: number; total: number } | null = null
  // Write sequence: every upserted row is stamped with the next value, so a
  // reconcile can tell rows written after its scan began (see `mark`).
  let seq = Number(db.prepare("SELECT coalesce(max(written), 0) AS m FROM docs").get()?.m ?? 0)

  function inTransaction<T>(fn: () => T): T {
    db.exec("BEGIN IMMEDIATE")
    try {
      const out = fn()
      db.exec("COMMIT")
      return out
    } catch (err) {
      db.exec("ROLLBACK")
      throw err
    }
  }

  function dropRow(rowid: number, hasText: boolean): void {
    if (hasText) deleteFts.run(rowid)
    deleteDoc.run(rowid)
  }

  function currentStats(): { n: number; total: number } {
    if (!stats) {
      const row = statsStmt.get()
      stats = { n: Number(row?.n ?? 0), total: Number(row?.total ?? 0) }
    }
    return stats
  }

  const ops = {
    info(): FtsInfo {
      return {
        docs: currentStats().n,
        complete: metaGet.get("complete")?.value === "1",
        created,
        sqliteVersion,
      }
    },

    mark(): number {
      return seq
    },

    diff(args: { manifest: FtsManifest; mark: number }): FtsDiff {
      const known = new Map<string, { rowid: number; size: number; mtime: number; hasText: boolean; written: number }>()
      for (const row of allDocs.all()) {
        known.set(String(row.path), {
          rowid: Number(row.rowid),
          size: Number(row.size),
          mtime: Number(row.mtime),
          hasText: Number(row.has_text) === 1,
          written: Number(row.written),
        })
      }
      const { sizes, mtimes } = args.manifest
      const paths = args.manifest.paths === "" ? [] : args.manifest.paths.split("\u0000")
      const changed: number[] = []
      let unchanged = 0
      paths.forEach((path, i) => {
        const row = known.get(path)
        if (row) known.delete(path)
        if (row && row.size === sizes[i] && row.mtime === mtimes[i]) unchanged++
        else changed.push(i)
      })
      // Whatever is left has no file any more, except rows written after the
      // scan began (an ingest racing the reconcile): those stay.
      let removed = 0
      inTransaction(() => {
        for (const row of known.values()) {
          if (row.written > args.mark) continue
          dropRow(row.rowid, row.hasText)
          removed++
        }
      })
      if (removed > 0) stats = null
      return { changed: Uint32Array.from(changed), removed, unchanged }
    },

    upsert(args: { docs: readonly FtsUpsertDoc[] }): { added: number; updated: number } {
      let added = 0
      let updated = 0
      inTransaction(() => {
        for (const doc of args.docs) {
          const hasText = doc.text.length > 0
          const tokens = hasText ? tokenize(doc.text) : []
          const row = selectDoc.get(doc.path)
          let rowid: number
          if (row) {
            rowid = Number(row.rowid)
            if (Number(row.has_text) === 1) deleteFts.run(rowid)
            updateDoc.run(doc.size, doc.mtimeMs, tokens.length, hasText ? 1 : 0, ++seq, rowid)
            updated++
          } else {
            const res = insertDoc.run(
              doc.path, doc.size, doc.mtimeMs, tokens.length, hasText ? 1 : 0, ++seq
            ) as { lastInsertRowid: number | bigint }
            rowid = Number(res.lastInsertRowid)
            added++
          }
          if (hasText) insertFts.run(rowid, tokens.join(" "))
        }
      })
      stats = null
      return { added, updated }
    },

    remove(args: { paths: readonly string[] }): { removed: number } {
      let removed = 0
      inTransaction(() => {
        for (const path of args.paths) {
          const row = selectDoc.get(path)
          if (!row) continue
          dropRow(Number(row.rowid), Number(row.has_text) === 1)
          removed++
        }
      })
      stats = null
      return { removed }
    },

    setComplete(args: { complete: boolean }): null {
      metaSet.run("complete", args.complete ? "1" : "0")
      return null
    },

    search(args: { tokens: readonly string[]; limit: number }): FtsSearchResult {
      const { n, total } = currentStats()
      const distinct = [...new Set(args.tokens)]
      const df: Record<string, number> = {}
      for (const term of distinct) df[term] = Number(dfStmt.get(term)?.doc ?? 0)
      const present = args.tokens.filter(t => df[t]! > 0)
      const candidates: FtsCandidate[] = []
      if (present.length > 0) {
        // Tokens are [a-z0-9] only, so quoting each one is a safe phrase.
        // A repeated token stays repeated: bm25() then counts it again, like
        // the in-memory scorer.
        const match = present.map(t => `"${t}"`).join(" OR ")
        for (const row of searchStmt.all(match, args.limit)) {
          const path = pathOf.get(Number(row.rowid))?.path
          if (typeof path === "string") candidates.push({ path, ftsScore: -Number(row.s) })
        }
      }
      return { candidates, docs: n, avgDocLength: n === 0 ? 0 : total / n, df }
    },

    list(): readonly string[] {
      return listStmt.all().map(row => String(row.path))
    },

    has(args: { path: string }): boolean {
      return Number(selectDoc.get(args.path)?.has_text ?? 0) === 1
    },

    tokenize(args: { text: string }): readonly string[] {
      return tokenize(args.text)
    },

    close(): null {
      db.close()
      return null
    },
  }

  return {
    handle(op, args) {
      const fn = (ops as Record<string, (a: unknown) => unknown>)[op]
      if (!fn) throw new Error(`fts store: unknown op "${String(op)}"`)
      return fn(args) as never
    },
  }
}
