/**
 * Fresh import graph for a workflow entry module.
 *
 * `import(entry + "?v=mtime")` re-evaluates the entry itself, but Node keys
 * its module cache by URL, so the entry's RELATIVE imports (`./cron-rules.mjs`)
 * keep resolving to the copy cached when the daemon booted: after a `git pull`
 * the entry ran new code against stale helpers until the daemon restarted.
 *
 * A resolve hook closes that: every relative import made from a module that
 * carries the version param inherits the same param, so the whole
 * entry-local graph is re-read when (and only when) a file in the entry
 * directory changed. Bare specifiers (`node_modules`, workspace packages)
 * are never versioned, so shared library singletons stay single instances.
 */

import { readdir, stat } from "node:fs/promises"
import { register } from "node:module"
import { join } from "node:path"

/** Query param that carries the entry-graph version. */
export const ENTRY_GRAPH_VERSION_PARAM = "agentproto_v"

/** Source of the resolve hook, loaded through a `data:` URL so no file has to
 *  ship next to the bundle. Exported so tests can run it in a real process. */
export const ENTRY_GRAPH_HOOK_SOURCE = `
const PARAM = ${JSON.stringify(ENTRY_GRAPH_VERSION_PARAM)}
export async function resolve(specifier, context, nextResolve) {
  const result = await nextResolve(specifier, context)
  const relative = specifier.startsWith("./") || specifier.startsWith("../")
  if (!relative || !context.parentURL || !result.url.startsWith("file:") || result.url.includes("/node_modules/")) return result
  let version
  try {
    version = new URL(context.parentURL).searchParams.get(PARAM)
  } catch {
    return result
  }
  if (version === null) return result
  const url = new URL(result.url)
  url.searchParams.set(PARAM, version)
  return { ...result, url: url.href }
}
`

const SCRIPT_EXT = /\.(?:mjs|js|cjs|json)$/
const MAX_DEPTH = 3

async function newestMtimeMs(dir: string, depth: number): Promise<number> {
  let newest = 0
  let entries: import("node:fs").Dirent[]
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return 0
  }
  for (const e of entries) {
    if (e.name === "node_modules" || e.name.startsWith(".")) continue
    const p = join(dir, e.name)
    if (e.isDirectory()) {
      if (depth < MAX_DEPTH) newest = Math.max(newest, await newestMtimeMs(p, depth + 1))
    } else if (SCRIPT_EXT.test(e.name)) {
      try {
        newest = Math.max(newest, (await stat(p)).mtimeMs)
      } catch {
        // file vanished mid-scan — the next load picks it up.
      }
    }
  }
  return newest
}

/** Version of an entry's local graph: the newest mtime of any script/JSON file
 *  under the entry directory. Changes iff a file there was edited or replaced. */
export function entryGraphVersion(entryDir: string): Promise<number> {
  return newestMtimeMs(entryDir, 0)
}

let hookRegistered = false

/** Register the resolve hook once per process. Returns false (and the caller
 *  falls back to versioning the entry alone) when the runtime can't. */
export function registerEntryGraphHook(): boolean {
  if (hookRegistered) return true
  try {
    register(`data:text/javascript,${encodeURIComponent(ENTRY_GRAPH_HOOK_SOURCE)}`)
    hookRegistered = true
  } catch {
    return false
  }
  return true
}
