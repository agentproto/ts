import { homedir } from "node:os"
import { join, dirname } from "node:path"
import { mkdirSync, readFileSync, existsSync, writeFileSync, renameSync } from "node:fs"
import type { StepCache, StepCacheEntry } from "@agentproto/workflow-runtime"

const DEFAULT_CACHE_DIR = (): string => join(homedir(), ".agentproto", "workflow-cache")

/** Filesystem-safe file stem for a caller-supplied cacheKey. */
function sanitize(cacheKey: string): string {
  const cleaned = cacheKey.replace(/[^a-zA-Z0-9._-]/g, "_")
  return cleaned.length > 0 ? cleaned : "default"
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}
function isEntry(v: unknown): v is StepCacheEntry {
  return isRecord(v) && typeof v.resolvedInputHash === "string" && "output" in v
}

/** A journal-file StepCache scoped to one cacheKey. Best-effort: read/parse
 *  failures degrade to "no cache" (a miss), never throw into the run. */
export function createFileStepCache(cacheKey: string, opts?: { dir?: string }): StepCache {
  const dir = opts?.dir ?? DEFAULT_CACHE_DIR()
  const path = join(dir, `${sanitize(cacheKey)}.json`)

  const readAll = (): Record<string, StepCacheEntry> => {
    if (!existsSync(path)) return {}
    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(path, "utf8"))
    } catch {
      return {}
    }
    if (!isRecord(parsed)) return {}
    const out: Record<string, StepCacheEntry> = {}
    for (const [k, v] of Object.entries(parsed)) if (isEntry(v)) out[k] = v
    return out
  }

  return {
    get: async (key) => readAll()[key],
    set: async (key, entry) => {
      const all = readAll()
      all[key] = entry
      try {
        mkdirSync(dirname(path), { recursive: true })
        const tmp = `${path}.tmp.${process.pid}`
        writeFileSync(tmp, JSON.stringify(all, null, 2) + "\n", "utf8")
        renameSync(tmp, path)
      } catch {
        // best-effort — a cache write failure must not crash the run
      }
    },
  }
}
