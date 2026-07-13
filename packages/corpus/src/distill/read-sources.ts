/**
 * readDistillSources — scan `sources/**​/*.md` into {@link DistillSource}
 * objects, deriving each source's provenance `id` from FRONTMATTER `id` and its
 * distill body from the FRONTMATTER-STRIPPED content.
 *
 * This is the ONE implementation of the source-scan glue that used to live only
 * in the Bureau client's `corpus.provider.ts` (`readSources`). Extracting it
 * here (FsPort-based, like {@link scanDistilledSourceIds}) means the client
 * driver and the server-side synthesize payoff distill from IDENTICAL sources —
 * so the entries a server run produces carry the same `sources: [<id>]`
 * provenance backlinks and the same frontmatter-free LLM bodies a local run
 * would. Swapping in `LocalFilesImporter` (filename-slug id, whole-file body)
 * would silently drift provenance; this doesn't.
 */

import matter from "gray-matter"
import { z } from "zod"
import type { FsPort } from "../ports/fs.port.js"
import type { DistillSource } from "./runner.js"

/** Tolerant read of a source file's frontmatter — only the fields the scan
 *  needs, each defaulting to `undefined` on a type mismatch (never throws). */
const SOURCE_FM = z
  .object({
    id: z.string().optional().catch(undefined),
    title: z.string().optional().catch(undefined),
    tags: z.array(z.string()).optional().catch(undefined),
  })
  .loose()

export interface ReadDistillSourcesOptions {
  /** Cap the number of sources returned (scan stops once reached). */
  readonly max?: number
}

/**
 * Read every `sources/**​/*.md` under the workspace into a `DistillSource`.
 * A file is skipped when it has no frontmatter `id` or an empty body (the same
 * two skip conditions the client scan applies). Tolerant of both `walk`
 * conventions a host's FsPort may use (paths relative to the walked dir, or
 * anchored at the workspace root) by normalizing each back under `sources/`.
 */
export async function readDistillSources(
  fs: FsPort,
  opts: ReadDistillSourcesOptions = {}
): Promise<DistillSource[]> {
  let rels: readonly string[]
  try {
    rels = await fs.walk("sources")
  } catch {
    return []
  }
  const out: DistillSource[] = []
  for (const rel of rels) {
    if (!rel.endsWith(".md")) continue
    const path = rel.startsWith("sources/") ? rel : `sources/${rel}`
    try {
      const parsed = matter(await fs.readFile(path))
      const fm = SOURCE_FM.parse(parsed.data)
      const body = parsed.content.trim()
      if (!fm.id || !body) continue
      out.push({
        id: fm.id,
        title: fm.title ?? fm.id,
        body,
        ...(fm.tags ? { tags: fm.tags } : {}),
      })
    } catch {
      // unreadable / malformed frontmatter — skip
    }
    if (opts.max !== undefined && out.length >= opts.max) break
  }
  return out
}
