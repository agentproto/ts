import { readdir } from "node:fs/promises"
import { join, posix } from "node:path"

function escapeSegment(seg: string): string {
  let out = ""
  for (const ch of seg) {
    if (ch === "*") out += "[^/]*"
    else if (ch === "?") out += "[^/]"
    else out += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&")
  }
  return out
}

/** Compile a `/`-separated glob (supporting `*`, `?`, `**`) into an anchored regex. */
export function globToRegExp(pattern: string): RegExp {
  const segments = pattern.split("/")
  let out = "^"
  segments.forEach((seg, i) => {
    const isLast = i === segments.length - 1
    if (seg === "**") {
      out += isLast ? ".*" : "(?:[^/]+/)*"
      return
    }
    out += escapeSegment(seg)
    if (!isLast) out += "/"
  })
  return new RegExp(out + "$")
}

/** The literal (non-wildcard) directory prefix of a glob — where to start walking. */
function globBaseDir(pattern: string): string {
  const segments = pattern.split("/")
  const literal: string[] = []
  for (const seg of segments) {
    if (seg.includes("*") || seg.includes("?")) break
    literal.push(seg)
  }
  // Drop the last literal segment if it's the pattern's final segment (a filename),
  // not a directory to walk into.
  if (literal.length === segments.length) literal.pop()
  return literal.join("/")
}

async function walk(root: string, dirRel: string): Promise<string[]> {
  const abs = dirRel ? join(root, dirRel) : root
  let entries
  try {
    entries = await readdir(abs, { withFileTypes: true })
  } catch {
    return []
  }
  const out: string[] = []
  for (const entry of entries) {
    if (entry.name === ".git" || entry.name === "node_modules") continue
    const rel = dirRel ? posix.join(dirRel, entry.name) : entry.name
    // entry.isDirectory() is false for symlinked dirs (Dirent reports the link's own
    // type, not the target's) — keep it that way so we never follow symlinks.
    if (entry.isDirectory()) {
      const children = await walk(root, rel)
      for (const child of children) out.push(child)
    } else if (entry.isFile()) {
      out.push(rel)
    }
  }
  return out
}

/** Expand a glob against `root`, returning root-relative posix paths of matching files. */
export async function expandGlob(root: string, pattern: string): Promise<string[]> {
  const regex = globToRegExp(pattern)
  const base = globBaseDir(pattern)
  const candidates = await walk(root, base)
  return candidates.filter((rel) => regex.test(rel))
}

/** A `cloneGlobs`/`copyGlobs` pattern that could resolve outside its root — a
 *  leading `/`, or a literal `..` path segment. */
export class GlobTraversalError extends Error {
  constructor(pattern: string) {
    super(`glob pattern '${pattern}' escapes the repo root (path traversal)`)
    this.name = "GlobTraversalError"
  }
}

function assertNoTraversal(pattern: string): void {
  if (pattern.startsWith("/")) throw new GlobTraversalError(pattern)
  if (pattern.split("/").some((seg) => seg === "..")) throw new GlobTraversalError(pattern)
}

/**
 * Expand a glob against `root` for CLONING a whole entry. Unlike
 * {@link expandGlob} — which enumerates individual FILES and deliberately
 * skips descending into `node_modules` — this matches whole entries (files
 * OR directories) and never descends past a match: a matching directory is
 * returned as a single unit for the caller to clone as a whole tree, so a
 * pattern like `node_modules` costs one `readdir`, not a walk of everything
 * inside it. `**` is not supported (a clone target must be a single named
 * entry per level, not an arbitrary-depth wildcard) and throws.
 *
 * Throws {@link GlobTraversalError} on a pattern that could resolve outside
 * `root` (a leading `/`, or any `..` segment) — checked before any
 * filesystem access.
 */
export async function expandCloneGlob(root: string, pattern: string): Promise<string[]> {
  assertNoTraversal(pattern)
  const segments = pattern.split("/").filter((seg) => seg.length > 0)
  if (segments.length === 0) return []
  if (segments.includes("**")) {
    throw new Error(
      `cloneGlobs pattern '${pattern}' uses '**', which is not supported — name each ` +
        "path segment explicitly so a directory match clones as one unit.",
    )
  }

  async function walkMatch(dirRel: string, idx: number): Promise<string[]> {
    // `idx` never exceeds `segments.length - 1` — the only caller is this
    // function itself (recursing with `idx + 1`, guarded by `!isLast`) and
    // the initial `walkMatch("", 0)` below, with `segments.length >= 1`
    // already checked above.
    const seg = segments[idx]!
    const isLast = idx === segments.length - 1
    const abs = dirRel ? join(root, dirRel) : root
    let entries
    try {
      entries = await readdir(abs, { withFileTypes: true })
    } catch {
      return []
    }
    const regex = new RegExp(`^${escapeSegment(seg)}$`)
    const out: string[] = []
    for (const entry of entries) {
      if (entry.name === ".git") continue
      if (!regex.test(entry.name)) continue
      const rel = dirRel ? posix.join(dirRel, entry.name) : entry.name
      if (isLast) {
        out.push(rel)
        continue
      }
      // Only a directory can hold the next segment; a match this deep that
      // isn't one is a dead end for the rest of the pattern.
      if (entry.isDirectory()) {
        out.push(...(await walkMatch(rel, idx + 1)))
      }
    }
    return out
  }

  return walkMatch("", 0)
}
