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
 * `record`/`forget` calls against ONE `BrainState` instance are serialized
 * (see `enqueue` below): `workspace-brain-subscriber.ts` fires one
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
import type { BrainStateRecord } from "./types.js"

export const BRAIN_STATE_FILENAME = "brain-state.json"

/** A record per session, keyed by session id. */
export interface BrainStateFile {
  readonly version: 1
  readonly updatedAt: string
  readonly ingested: Readonly<Record<string, BrainStateRecord>>
}

/** The read/write surface the pipeline + manager share. */
export interface BrainState {
  /** Path to `brain-state.json` on disk. */
  readonly path: string
  /** All recorded ingestions, keyed by session id. Never throws. */
  read(): Promise<Readonly<Record<string, BrainStateRecord>>>
  /** Record an ingestion for `sessionId`. Atomic write. */
  record(record: BrainStateRecord): Promise<void>
  /** Drop an ingestion record (used by a manual re-ingest). */
  forget(sessionId: string): Promise<void>
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
      return { version: 1, updatedAt: "", ingested: {} }
    }
    try {
      const parsed = JSON.parse(raw) as Partial<BrainStateFile>
      if (
        parsed &&
        typeof parsed === "object" &&
        parsed.ingested &&
        typeof parsed.ingested === "object"
      ) {
        const ingested = parsed.ingested as Record<string, BrainStateRecord>
        const clean: Record<string, BrainStateRecord> = {}
        for (const [id, rec] of Object.entries(ingested)) {
          if (rec && typeof rec.sessionId === "string" && typeof rec.sourceId === "string") {
            clean[id] = rec
          }
        }
        return {
          version: 1,
          updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : "",
          ingested: clean,
        }
      }
    } catch {
      // malformed — degrade to empty
    }
    return { version: 1, updatedAt: "", ingested: {} }
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
        await writeFile({ version: 1, updatedAt: new Date().toISOString(), ingested })
      })
    },
    forget(sessionId) {
      return enqueue(async () => {
        const file = await readFile()
        if (!(sessionId in file.ingested)) return
        const ingested = { ...file.ingested }
        delete ingested[sessionId]
        await writeFile({ version: 1, updatedAt: new Date().toISOString(), ingested })
      })
    },
  }
}
