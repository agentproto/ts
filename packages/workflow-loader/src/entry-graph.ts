/**
 * Fresh import graph for a workflow entry module.
 *
 * `import(entry + "?v=mtime")` re-evaluates the entry itself, but Node keys
 * its module cache by URL, so the entry's RELATIVE imports (`./cron-rules.mjs`)
 * keep resolving to the copy cached when the daemon booted: after a `git pull`
 * the entry ran new code against stale helpers until the daemon restarted.
 *
 * A resolve hook closes that: every relative import made from a module that
 * carries the version param inherits the same param, and the version is a
 * content hash of the entry's whole relative-import graph (any depth, any
 * directory), so the graph is re-read when, and only when, one of its files
 * changed. Bare specifiers (`node_modules`, workspace packages)
 * are never versioned, so shared library singletons stay single instances.
 */

import { createHash } from "node:crypto"
import { readFile, readdir } from "node:fs/promises"
import { register } from "node:module"
import { dirname, join, resolve, sep } from "node:path"

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
const CODE_EXT = /\.(?:mjs|js|cjs|jsx|ts|mts|cts|tsx)$/
const MAX_DEPTH = 3
const MAX_GRAPH_FILES = 1000

/** Relative specifiers in static `import` / `export … from` / `import()` /
 *  `require()`. Matches inside comments or strings too: that only over-includes
 *  a file (or a path that doesn't exist and is skipped), never misses one. */
const RELATIVE_SPECIFIER_RE = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)(["'])(\.{1,2}\/[^"'\n]*)\1/g

async function listScripts(dir: string, depth: number, out: Set<string>): Promise<void> {
  let entries: import("node:fs").Dirent[]
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    if (e.name === "node_modules" || e.name.startsWith(".")) continue
    const p = join(dir, e.name)
    if (e.isDirectory()) {
      if (depth < MAX_DEPTH) await listScripts(p, depth + 1, out)
    } else if (SCRIPT_EXT.test(e.name)) {
      out.add(p)
    }
  }
}

function relativeImportsOf(file: string, source: string): string[] {
  const found: string[] = []
  for (const m of source.matchAll(RELATIVE_SPECIFIER_RE)) {
    const spec = m[2]!.replace(/[?#].*$/, "")
    const target = resolve(dirname(file), spec)
    if (!target.includes(`${sep}node_modules${sep}`)) found.push(target)
  }
  return found
}

/**
 * Version of an entry's local module graph: a content hash over every file the
 * entry can reach through relative imports (any depth, any directory — a
 * sibling `../shared/x.mjs` counts) plus every script/JSON file under the entry
 * directory (covers computed `import()` paths the static scan can't see).
 * Changes iff the content of one of those files changes, a file is added or
 * removed, or the graph's shape changes; an untouched graph yields the same
 * string, so the loader serves Node's module cache instead of re-evaluating.
 * Returns "" when the entry cannot be read.
 */
export async function entryGraphVersion(entryFile: string): Promise<string> {
  const files = new Set<string>([resolve(entryFile)])
  await listScripts(dirname(entryFile), 0, files)
  const pending = [...files]
  const walked = new Set<string>()
  const digests = new Map<string, string>()
  while (pending.length > 0 && walked.size < MAX_GRAPH_FILES) {
    const file = pending.pop()!
    if (walked.has(file)) continue
    walked.add(file)
    let bytes: Buffer
    try {
      bytes = await readFile(file)
    } catch {
      continue // missing import target or a file that vanished mid-scan
    }
    digests.set(file, createHash("sha1").update(bytes).digest("hex"))
    if (!CODE_EXT.test(file)) continue
    for (const target of relativeImportsOf(file, bytes.toString("utf8"))) {
      if (!walked.has(target)) pending.push(target)
    }
  }
  if (digests.size === 0) return ""
  const h = createHash("sha1")
  for (const file of [...digests.keys()].sort()) h.update(`${file}\0${digests.get(file)}\0`)
  return h.digest("hex").slice(0, 16)
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
