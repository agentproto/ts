/**
 * `brain-state.json` persistence — "which sessions did I ingest, and as what".
 *
 * The state is a single JSON file living at the brain root, keyed by session
 * id (a record per ingested session plus the last-updated timestamp). It is
 * written ATOMICALLY (tmp + rename, mirroring `writeBucketSnapshot` in the
 * workspace-buckets module) so a concurrent reader never observes half a
 * file, and read defensively: a missing file means "nothing ingested yet", a
 * corrupt file reads back as empty rather than throwing — the same
 * degrade-to-empty contract every other on-disk reader in the runtime uses.
 *
 * Alongside `ingested`, the file also tracks `skips` — sessions whose
 * transcript was unavailable on the last attempt (e.g. a bash PTY or a
 * GC'd transcript, which will never produce one). Recording those keeps
 * `pendingSessions` from re-counting them forever; it is not a tombstone,
 * since an explicit re-ingest or a later successful ingest still clears it
 * (see `record`/`recordSkip` below).
 *
 * `record`/`forget`/`recordSkip` calls against ONE `BrainState` instance are
 * serialized (see `enqueue` below): `workspace-brain-subscriber.ts` fires one
 * `ingest()` per session exiting inside the same debounce batch, all against
 * the same per-workspace `BrainManager`/`BrainState`, with no ordering
 * between them — an unserialized read-modify-write here raced on the tmp
 * filename (unique only per-process, not per-call) and corrupted
 * `brain-state.json` in production (a valid JSON body followed by a stray
 * `}` from an interleaved write). Serializing turns that into a queue: each
 * call's read/merge/write runs after the previous one's write has landed.
 */

import { promises as fs } from "node:fs"
import { dirname, join } from "node:path"
import type { BrainStateRecord, BrainStateSkip } from "./types.js"

export const BRAIN_STATE_FILENAME = "brain-state.json"

/** A record per session, keyed by session id. */
export interface BrainStateFile {
  readonly version: 1
  readonly updatedAt: string
  readonly ingested: Readonly<Record<string, BrainStateRecord>>
  /** Sessions skipped as permanently-unavailable-for-now. Absent on files
   *  written before this field existed — treated as `{}` (see `readFile`). */
  readonly skips: Readonly<Record<string, BrainStateSkip>>
}

/** The read/write surface the pipeline + manager share. */
export interface BrainState {
  /** Path to `brain-state.json` on disk. */
  readonly path: string
  /** All recorded ingestions, keyed by session id. Never throws. */
  read(): Promise<Readonly<Record<string, BrainStateRecord>>>
  /** Record an ingestion for `sessionId`. Atomic write. Clears any skip
   *  entry for the same session — a successful ingest is never also
   *  "skipped". */
  record(record: BrainStateRecord): Promise<void>
  /** Drop an ingestion record (used by a manual re-ingest). */
  forget(sessionId: string): Promise<void>
  /** All recorded skips, keyed by session id. Never throws. */
  readSkips(): Promise<Readonly<Record<string, BrainStateSkip>>>
  /** Record `sessionId` as skipped for `reason`. Atomic write. NOT a
   *  tombstone — a later `record()` for the same session clears it. */
  recordSkip(sessionId: string, reason: BrainStateSkip["reason"]): Promise<void>
}

export const brainStatePath = (brainDir: string): string =>
  join(brainDir, BRAIN_STATE_FILENAME)

export function createBrainState(brainDir: string): BrainState {
  const path = brainStatePath(brainDir)

  // Chains every mutating call onto the previous one so a read-modify-write
  // against this instance never interleaves with another. `.catch(() => {})`
  // keeps the chain alive after a rejection instead of wedging every
  // subsequent call behind a permanently-rejected promise.
  let queue: Promise<void> = Promise.resolve()
  const enqueue = <T>(fn: () => Promise<T>): Promise<T> => {
    const result = queue.then(fn, fn)
    queue = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  const readFile = async (): Promise<BrainStateFile> => {
    let raw: string
    try {
      raw = await fs.readFile(path, "utf8")
    } catch {
      return { version: 1, updatedAt: "", ingested: {}, skips: {} }
    }
    try {
      const parsed = JSON.parse(raw) as Partial<BrainStateFile>
      if (
        parsed &&
        typeof parsed === "object" &&
        parsed.ingested &&
        typeof parsed.ingested === "object"
      ) {
        const ingestedRaw = parsed.ingested as Record<string, BrainStateRecord>
        const ingested: Record<string, BrainStateRecord> = {}
        for (const [id, rec] of Object.entries(ingestedRaw)) {
          if (rec && typeof rec.sessionId === "string" && typeof rec.sourceId === "string") {
            ingested[id] = rec
          }
        }
        // `skips` was added after v1 shipped — a legacy file simply lacks
        // the field, which parses as "no skips" rather than corrupt.
        const skipsRaw =
          parsed.skips && typeof parsed.skips === "object"
            ? (parsed.skips as Record<string, BrainStateSkip>)
            : {}
        const skips: Record<string, BrainStateSkip> = {}
        for (const [id, rec] of Object.entries(skipsRaw)) {
          if (rec && typeof rec.sessionId === "string" && typeof rec.reason === "string") {
            skips[id] = rec
          }
        }
        return {
          version: 1,
          updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : "",
          ingested,
          skips,
        }
      }
    } catch {
      // malformed — degrade to empty
    }
    return { version: 1, updatedAt: "", ingested: {}, skips: {} }
  }

  // Singletons per workspace; the host Map enforces this. Atomic writes here
  // guard against a half-written file; `enqueue` (above) guards against two
  // calls on this instance racing each other. A per-call tmp suffix is
  // defense in depth on top of that — `process.pid` alone isn't unique
  // per call, so two interleaved writers sharing it is what corrupted
  // `brain-state.json` before `enqueue` existed.
  let writeCounter = 0
  const writeFile = async (file: BrainStateFile): Promise<void> => {
    await fs.mkdir(dirname(path), { recursive: true })
    const tmp = `${path}.tmp-${process.pid}-${writeCounter++}`
    await fs.writeFile(tmp, JSON.stringify(file, null, 2) + "\n", "utf8")
    await fs.rename(tmp, path)
  }

  return {
    path,
    async read() {
      return (await readFile()).ingested
    },
    record(record) {
      return enqueue(async () => {
        const file = await readFile()
        const ingested = { ...file.ingested, [record.sessionId]: record }
        const skips = { ...file.skips }
        delete skips[record.sessionId]
        await writeFile({ version: 1, updatedAt: new Date().toISOString(), ingested, skips })
      })
    },
    forget(sessionId) {
      return enqueue(async () => {
        const file = await readFile()
        if (!(sessionId in file.ingested)) return
        const ingested = { ...file.ingested }
        delete ingested[sessionId]
        await writeFile({
          version: 1,
          updatedAt: new Date().toISOString(),
          ingested,
          skips: file.skips,
        })
      })
    },
    async readSkips() {
      return (await readFile()).skips
    },
    recordSkip(sessionId, reason) {
      return enqueue(async () => {
        const file = await readFile()
        const skip: BrainStateSkip = { sessionId, reason, skippedAt: new Date().toISOString() }
        const skips = { ...file.skips, [sessionId]: skip }
        await writeFile({
          version: 1,
          updatedAt: new Date().toISOString(),
          ingested: file.ingested,
          skips,
        })
      })
    },
  }
}
