/**
 * resolveKnowledge — the `knowledge:` binding resolver (KNOWLEDGE→SKILL link).
 *
 * Filesystem-first: a skill's binding (`{ tags, kinds }`) is resolved against
 * the refined `entries/**​/*.md` on disk — no graph engine. Returns the
 * matching refined entries (with their `sources:` provenance), filtered by the
 * caller's access scope so an operator never sees knowledge above its clearance.
 *
 * A graph engine (mind-graph / gbrain) can later replace this scan with
 * traversal/activation behind the SAME signature — the binding contract is stable.
 */

import matter from "gray-matter"
import { z } from "zod"
import type { FsPort } from "../ports/fs.port.js"
import { isRefinedKind, type RefinedKind } from "../distill/types.js"

/**
 * Lenient zod view of an AIP-10 entry's frontmatter. Every field `.catch`es to
 * undefined so a malformed value degrades gracefully (the entry is still
 * parsed, the bad field is simply absent) — matching the previous defensive
 * hand-narrowing, but typed and cast-free.
 */
const ENTRY_FRONTMATTER = z
  .object({
    schema: z.string().optional().catch(undefined),
    slug: z.string().optional().catch(undefined),
    kind: z.string().optional().catch(undefined),
    title: z.string().optional().catch(undefined),
    sources: z.array(z.string()).optional().catch(undefined),
    confidence: z.number().optional().catch(undefined),
    tags: z.array(z.string()).optional().catch(undefined),
    metadata: z
      .object({
        corpus: z
          .object({
            access: z.string().optional().catch(undefined),
            status: z.string().optional().catch(undefined),
          })
          .loose()
          .optional()
          .catch(undefined),
      })
      .loose()
      .optional()
      .catch(undefined),
  })
  .loose()

export interface KnowledgeQuery {
  /** Match entries sharing ANY of these tags. Empty/absent = no tag filter. */
  readonly tags?: readonly string[]
  /** Restrict to these refined kinds. Empty/absent = all kinds. */
  readonly kinds?: readonly RefinedKind[]
  /** Cap results (highest-confidence first). */
  readonly maxResults?: number
}

export interface ResolvedEntry {
  readonly slug: string
  readonly kind: string
  readonly title: string
  readonly body: string
  /** Provenance — the raw source ids this entry was derived from. */
  readonly sources: readonly string[]
  readonly confidence: number
  readonly tags: readonly string[]
  readonly access?: string
  readonly path: string
}

export interface ResolveKnowledgeOptions {
  readonly fs: FsPort
  readonly query: KnowledgeQuery
  /**
   * Access scopes the caller (operator) is cleared for. An entry passes if it
   * has no access (public) or its access ∈ this set. Omit = no access filter.
   */
  readonly allowedAccess?: ReadonlySet<string>
}

export async function resolveKnowledge(
  opts: ResolveKnowledgeOptions
): Promise<readonly ResolvedEntry[]> {
  const { fs, query, allowedAccess } = opts
  const wantTags = new Set((query.tags ?? []).map(t => t.toLowerCase()))
  const wantKinds = query.kinds ? new Set(query.kinds) : null

  let rels: readonly string[]
  try {
    rels = await fs.walk("entries")
  } catch {
    return []
  }

  const hits: ResolvedEntry[] = []
  for (const rel of rels) {
    if (!rel.endsWith(".md")) continue
    // `walk("entries")` yields paths relative to the entries/ dir; readFile
    // resolves against the workspace root, so re-prefix.
    const path = `entries/${rel}`
    let parsed
    try {
      parsed = matter(await fs.readFile(path))
    } catch {
      continue
    }
    const fm = ENTRY_FRONTMATTER.parse(parsed.data)
    if (fm.schema !== "knowledge.entry/v1") continue

    // Tombstone: a guild disables a pack entry by shadowing it (same path) with
    // status "archived". Filtered here so the overlaid archived entry hides the
    // pack's. Absent/active = shown — only an explicit archive subtracts.
    if (fm.metadata?.corpus?.status === "archived") continue

    const kind = fm.kind ?? ""
    if (wantKinds && !(isRefinedKind(kind) && wantKinds.has(kind))) continue

    const tags = fm.tags ?? []
    if (wantTags.size > 0 && !tags.some(t => wantTags.has(t.toLowerCase()))) continue

    const access = fm.metadata?.corpus?.access
    if (allowedAccess && access && !allowedAccess.has(access)) continue

    hits.push({
      slug: fm.slug ?? path,
      kind,
      title: fm.title ?? "",
      body: parsed.content.trim(),
      sources: fm.sources ?? [],
      confidence: fm.confidence ?? 0,
      tags,
      ...(access ? { access } : {}),
      path,
    })
  }

  hits.sort((a, b) => b.confidence - a.confidence)
  return query.maxResults !== undefined ? hits.slice(0, query.maxResults) : hits
}
