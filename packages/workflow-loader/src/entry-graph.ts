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
 *
 * Which hook API: `module.registerHooks()` (synchronous, in-thread, Node
 * >= 22.15) when the runtime has it, else the original `module.register()`
 * data-URL hook (Node >= 20.6, the engines floor). `register()` runs hooks on
 * a dedicated loader thread, so every ESM resolve in the process — including
 * every FAILED dynamic import — round-trips through that thread's message
 * channel; on Node 22 those failed imports have been observed to leak the
 * channel's MessagePorts (async handles not reclaimed by GC), and a long-lived
 * daemon that routinely imports missing names pays for every miss.
 * `registerHooks()` never creates the channel: resolution stays on the main
 * thread, the process holds no loader-thread pipes, and the failed-import
 * error path has no port to leak. The fallback keeps hot-reload versioning
 * working on older supported Nodes, but cannot avoid the channel — that would
 * need an engine floor of 22.15, which this change deliberately does not
 * raise. Both paths share one pure rewrite ({@link appendEntryGraphVersion});
 * only the `nextResolve` protocol differs (the off-thread chain hands the
 * hook a Promise it must await, the in-thread chain a plain result).
 */

import { createHash } from "node:crypto"
import { readFile, readdir } from "node:fs/promises"
import * as nodeModule from "node:module"
import type { ResolveFnOutput, ResolveHookSync } from "node:module"
import { dirname, join, resolve, sep } from "node:path"

/** Query param that carries the entry-graph version. */
export const ENTRY_GRAPH_VERSION_PARAM = "agentproto_v"

/**
 * Append the parent's entry-graph version to a resolved RELATIVE file import;
 * pass everything else through untouched. The one piece of hook logic, shared
 * verbatim by the synchronous and asynchronous registrations.
 *
 * Preserves existing query strings (the version is appended, not substituted)
 * and never rewrites non-file URLs, bare specifiers, `node_modules` paths, or
 * parents that carry no version — a `require()`d CJS parent, which
 * `registerHooks()` also routes here, has no param and is a pass-through.
 */
export function appendEntryGraphVersion(
  specifier: string,
  context: { parentURL?: string | undefined },
  result: ResolveFnOutput,
): ResolveFnOutput {
  const relative = specifier.startsWith("./") || specifier.startsWith("../")
  if (!relative || !context.parentURL || !result.url.startsWith("file:") || result.url.includes("/node_modules/")) return result
  let version
  try {
    version = new URL(context.parentURL).searchParams.get(ENTRY_GRAPH_VERSION_PARAM)
  } catch {
    return result
  }
  if (version === null) return result
  const url = new URL(result.url)
  url.searchParams.set(ENTRY_GRAPH_VERSION_PARAM, version)
  return { ...result, url: url.href }
}

/** In-thread resolve hook handed to `module.registerHooks()`: the sync chain
 *  returns a plain result from `nextResolve`. */
export const entryGraphResolveSync: ResolveHookSync = (specifier, context, nextResolve) =>
  appendEntryGraphVersion(specifier, context, nextResolve(specifier, context))

/** Source of the `module.register()` fallback hook, loaded through a `data:`
 *  URL so no file has to ship next to the bundle. Built from
 *  {@link appendEntryGraphVersion} itself (stringified; the TS types are gone
 *  by the time this runs, and the param const is re-declared for the data:URL
 *  module), so the fallback cannot drift from the primary path. The wrapper is
 *  `async` on purpose: off-thread `nextResolve` returns a Promise. Exported so
 *  tests can run it in a real process. */
export const ENTRY_GRAPH_HOOK_SOURCE = `const ENTRY_GRAPH_VERSION_PARAM = ${JSON.stringify(ENTRY_GRAPH_VERSION_PARAM)}
const appendEntryGraphVersion = ${String(appendEntryGraphVersion)}
export async function resolve(specifier, context, nextResolve) {
  return appendEntryGraphVersion(specifier, context, await nextResolve(specifier, context))
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

/**
 * Register the resolve hook once per process: prefer the synchronous in-thread
 * `module.registerHooks()` (Node >= 22.15) — resolution never leaves the main
 * thread, no loader-thread channel exists to leak — and fall back to the
 * off-thread `module.register()` data-URL hook on older supported Nodes
 * (engines floor 20.9 has no `registerHooks`). Returns false (and the caller
 * falls back to versioning the entry alone) when neither registration works.
 *
 * Takes the two registrars as parameters so the branch selection is testable:
 * `nodeModule.registerHooks` is read from the namespace (NOT a named import —
 * a named import of a binding an old runtime lacks fails at link time, before
 * any of this runs).
 */
export function installEntryGraphHook(
  syncRegisterHooks: unknown,
  asyncRegister: (specifier: string) => void,
): boolean {
  if (typeof syncRegisterHooks === "function") {
    try {
      ;(syncRegisterHooks as (options: { resolve: ResolveHookSync }) => void)({
        resolve: entryGraphResolveSync,
      })
      return true
    } catch {
      // a runtime that has the API but refuses it still gets the fallback
    }
  }
  try {
    asyncRegister(`data:text/javascript,${encodeURIComponent(ENTRY_GRAPH_HOOK_SOURCE)}`)
    return true
  } catch {
    return false
  }
}

/** Register the resolve hook once per process. See
 *  {@link installEntryGraphHook} for the sync-preferred / async-fallback
 *  choice and its limitation on pre-22.15 runtimes. */
export function registerEntryGraphHook(): boolean {
  if (hookRegistered) return true
  const ok = installEntryGraphHook(nodeModule.registerHooks, specifier => nodeModule.register(specifier))
  if (ok) hookRegistered = true
  return ok
}
