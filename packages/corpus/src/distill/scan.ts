/**
 * scanDistilledSourceIds — which raw source ids already have ≥1 refined entry
 * derived from them, found by reading the `sources:` provenance backlink on
 * every `entries/**​/*.md`. Lets an incremental distill skip sources already
 * done, so a daily re-run is idempotent (no duplicate entries, no wasted spend).
 *
 * Tolerant of both `walk` conventions a host's FsPort may use — paths relative
 * to the walked dir (MemFs) or anchored at the workspace root (a workspace
 * adapter) — by normalizing each back under `entries/` before reading.
 */

import matter from "gray-matter"
import { z } from "zod"
import type { FsPort } from "../ports/fs.port.js"

const ENTRY_SOURCES = z
  .object({ sources: z.array(z.string()).optional().catch(undefined) })
  .loose()

export async function scanDistilledSourceIds(
  fs: FsPort
): Promise<Set<string>> {
  const ids = new Set<string>()
  let rels: readonly string[]
  try {
    rels = await fs.walk("entries")
  } catch {
    return ids
  }
  for (const rel of rels) {
    if (!rel.endsWith(".md")) continue
    const path = rel.startsWith("entries/") ? rel : `entries/${rel}`
    try {
      const fm = ENTRY_SOURCES.parse(matter(await fs.readFile(path)).data)
      if (fm.sources) for (const s of fm.sources) ids.add(s)
    } catch {
      // unreadable / no frontmatter — skip
    }
  }
  return ids
}
