/**
 * Session cache manifest: which paths of a per-session adapter config dir
 * are disposable cache, as opposed to the state a resume needs.
 *
 * The driver is the one place that knows the dir's layout (which base dir it
 * redirected where, which shared caches it linked), so it records that
 * knowledge next to the content, at spawn time. Session GC then reads the
 * manifest instead of knowing every adapter: a dead lineage loses exactly the
 * paths listed and keeps the rest (opencode's `opencode.db`, claude-code's
 * `projects/*.jsonl`). The manifest moves with the dir, so a dir whose
 * session descriptor was already forgotten is still prunable.
 */

import { readFileSync, writeFileSync } from "node:fs"
import { isAbsolute, join, normalize, sep } from "node:path"

/** File name of the manifest, at the root of the session config dir. */
export const SESSION_CACHE_MANIFEST = ".agentproto-cache.json"

export interface SessionCacheManifest {
  version: 1
  /** Paths relative to the config dir that GC may delete once the session
   *  lineage is dead. Each stays inside the dir. */
  disposable: string[]
}

/** A relative path that stays inside its base dir, normalised to `/`. */
export function safeRelativeCachePath(p: string): string | undefined {
  if (typeof p !== "string" || p === "" || isAbsolute(p)) return undefined
  const n = normalize(p).split(sep).join("/")
  if (n === "." || n.startsWith("../") || n === ".." || n.split("/").includes("..")) return undefined
  return n.replace(/\/+$/, "")
}

export function readSessionCacheManifest(configDir: string): SessionCacheManifest | undefined {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(join(configDir, SESSION_CACHE_MANIFEST), "utf8"))
  } catch {
    return undefined
  }
  if (!raw || typeof raw !== "object") return undefined
  const list = (raw as { disposable?: unknown }).disposable
  if (!Array.isArray(list)) return undefined
  const disposable = [
    ...new Set(list.map(p => (typeof p === "string" ? safeRelativeCachePath(p) : undefined)).filter((p): p is string => !!p)),
  ]
  return { version: 1, disposable }
}

/**
 * Add `paths` to the dir's manifest (union with what earlier spawns of the
 * lineage recorded: a respawn may engage a different layout). Unsafe paths
 * are dropped. Best-effort: a manifest that cannot be written only means GC
 * finds nothing to prune in this dir.
 */
export function recordSessionCachePaths(configDir: string, paths: readonly string[]): void {
  const safe = paths.map(safeRelativeCachePath).filter((p): p is string => !!p)
  if (safe.length === 0) return
  const prior = readSessionCacheManifest(configDir)?.disposable ?? []
  const merged = [...new Set([...prior, ...safe])].sort()
  if (prior.length === merged.length) return
  const manifest: SessionCacheManifest = { version: 1, disposable: merged }
  try {
    writeFileSync(join(configDir, SESSION_CACHE_MANIFEST), JSON.stringify(manifest, null, 2) + "\n")
  } catch {
    // best-effort, see above
  }
}
