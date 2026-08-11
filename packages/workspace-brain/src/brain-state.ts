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
  // guard against a half-written file, not against concurrent writers — two
  // `BrainManager`s for the same workspace would still race.
  const writeFile = async (file: BrainStateFile): Promise<void> => {
    await fs.mkdir(dirname(path), { recursive: true })
    const tmp = `${path}.tmp-${process.pid}`
    await fs.writeFile(tmp, JSON.stringify(file, null, 2) + "\n", "utf8")
    await fs.rename(tmp, path)
  }

  return {
    path,
    async read() {
      return (await readFile()).ingested
    },
    async record(record) {
      const file = await readFile()
      const ingested = { ...file.ingested, [record.sessionId]: record }
      await writeFile({ version: 1, updatedAt: new Date().toISOString(), ingested })
    },
    async forget(sessionId) {
      const file = await readFile()
      if (!(sessionId in file.ingested)) return
      const ingested = { ...file.ingested }
      delete ingested[sessionId]
      await writeFile({ version: 1, updatedAt: new Date().toISOString(), ingested })
    },
  }
}
