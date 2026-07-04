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
    if (entry.name === ".git") continue
    const rel = dirRel ? posix.join(dirRel, entry.name) : entry.name
    if (entry.isDirectory()) {
      out.push(...(await walk(root, rel)))
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
