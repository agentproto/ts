/**
 * Filesystem state store — one JSON file per participant.
 *
 *   <stateDir>/<participantId>.json
 *
 * Missing files read as {}. Writes are full overwrites; callers
 * pass the merged state, the adapter doesn't merge on its own.
 */

import { readFile, writeFile, mkdir, stat } from "node:fs/promises"
import { resolve as resolvePath } from "node:path"
import type { ParticipantId, StateStore } from "../ports.js"

export type FileStateStoreOptions = {
  /** Directory to hold the per-participant JSON files. */
  readonly dir: string
}

export class FileStateStore implements StateStore {
  readonly kind = "fs"

  constructor(private readonly opts: FileStateStoreOptions) {}

  async read(participantId: ParticipantId): Promise<Readonly<Record<string, unknown>>> {
    const path = this.pathFor(participantId)
    try {
      const raw = await readFile(path, "utf8")
      return JSON.parse(raw) as Record<string, unknown>
    } catch (err) {
      if (isNotFound(err)) return Object.freeze({})
      throw err
    }
  }

  async write(
    participantId: ParticipantId,
    state: Readonly<Record<string, unknown>>
  ): Promise<void> {
    await ensureDir(this.opts.dir)
    const path = this.pathFor(participantId)
    await writeFile(path, JSON.stringify(state, null, 2), "utf8")
  }

  private pathFor(participantId: ParticipantId): string {
    // Sanitize: participant ids are user-controlled. Disallow path traversal.
    const safe = participantId.replace(/[^a-zA-Z0-9._-]/g, "_")
    return resolvePath(this.opts.dir, `${safe}.json`)
  }
}

async function ensureDir(dir: string): Promise<void> {
  try {
    await stat(dir)
  } catch (err) {
    if (isNotFound(err)) {
      await mkdir(dir, { recursive: true })
      return
    }
    throw err
  }
}

function isNotFound(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: string }).code === "ENOENT"
  )
}
