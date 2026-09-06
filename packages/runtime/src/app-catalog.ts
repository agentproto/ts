/**
 * App catalog file — a static, hand-curated `~/.agentproto/app-catalog.json`
 * listing apps a user could `app_install`, independent of whether any are
 * installed yet. Read-only from the daemon's side; `app_catalog` (app-tools.ts)
 * merges it with `AppRegistry.listApps()` to report installed/hasUi status.
 */

import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"

export interface AppCatalogEntry {
  readonly appId: string
  readonly name?: string
  readonly description?: string
  readonly dir: string
  readonly category?: string
}

export interface AppCatalogFile {
  readonly apps: readonly AppCatalogEntry[]
}

const EMPTY_CATALOG: AppCatalogFile = { apps: [] }

export function defaultAppCatalogPath(): string {
  return join(homedir(), ".agentproto", "app-catalog.json")
}

/**
 * Read + parse the catalog file at `path` (default `~/.agentproto/app-catalog.json`).
 * Tolerates a missing file (returns an empty catalog) and a malformed one
 * (unreadable JSON, non-array `apps`, or entries missing `appId`/`dir` are
 * dropped) — never throws.
 */
export async function loadAppCatalogFile(path?: string): Promise<AppCatalogFile> {
  const catalogPath = path ?? defaultAppCatalogPath()
  let raw: string
  try {
    raw = await readFile(catalogPath, "utf8")
  } catch {
    return EMPTY_CATALOG
  }
  try {
    const parsed = JSON.parse(raw) as { apps?: unknown }
    if (!Array.isArray(parsed.apps)) return EMPTY_CATALOG
    const apps = parsed.apps.filter((e): e is AppCatalogEntry => {
      if (typeof e !== "object" || e === null) return false
      const rec = e as Record<string, unknown>
      return typeof rec.appId === "string" && typeof rec.dir === "string"
    })
    return { apps }
  } catch {
    return EMPTY_CATALOG
  }
}
