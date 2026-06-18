/**
 * CorpusIndexer — coordinator that ships active entries into the
 * backing engine via WriterPort.
 *
 * The kit doesn't know about IKnowledgeProvider — agstudio's
 * CorpusInternalWriter satisfies WriterPort and bridges to the
 * actual engine (qdrant / gbrain). Local topology supplies its own
 * WriterPort (e.g. dockered qdrant).
 *
 * Three public methods:
 *   - reindex(snapshot)     full sync: pushes every active entry
 *   - syncEntry(snapshot, slug)  delta: re-push a single entry
 *   - removeEntry(slug)     delta: drop a deprecated/archived entry
 *
 * Policy: only entries with `metadata.corpus.status === "active"`
 * (or unset, treated as active) are shipped. Deprecated/archived
 * entries are removed from the backing engine.
 */

import { chunkText, type ChunkerOptions } from "./chunker.js"
import type { WriterPort } from "../ports/writer.port.js"
import type {
  CorpusWorkspaceSnapshot,
  ParsedFile,
} from "../types.js"

export interface CorpusIndexerOptions {
  readonly writer: WriterPort
  /** Optional chunker tuning. Defaults match the backing engine's caps. */
  readonly chunker?: ChunkerOptions
}

export interface IndexReport {
  readonly pushed: number             // entries shipped
  readonly removed: number            // entries dropped
  readonly skipped: number            // entries skipped (non-active)
  readonly chunkCount: number         // total chunks pushed across entries
  readonly sourcesPushed: number      // source docs projected (graph writer)
}

export class CorpusIndexer {
  constructor(private readonly opts: CorpusIndexerOptions) {}

  /**
   * Re-sync every active entry. Used at boot (cold-install) and by
   * the admin `corpus reindex` command for drift recovery.
   */
  async reindex(snapshot: CorpusWorkspaceSnapshot): Promise<IndexReport> {
    let pushed = 0
    let removed = 0
    let skipped = 0
    let chunkCount = 0
    let sourcesPushed = 0

    // Sources first, so entry→source DERIVED_FROM edges land on fully-projected
    // Source nodes (not stubs). Only a graph writer implements pushSource; a
    // vector writer leaves it undefined and these are skipped.
    if (this.opts.writer.pushSource) {
      for (const source of snapshot.sources) {
        const sourceId = source.frontmatter.id
        if (typeof sourceId !== "string") continue
        await this.opts.writer.pushSource({
          sourceId,
          sourcePath: source.path,
          title:
            typeof source.frontmatter.title === "string"
              ? source.frontmatter.title
              : undefined,
          sourceFrontmatter: source.frontmatter,
        })
        sourcesPushed++
      }
    }

    for (const entry of snapshot.entries) {
      const status = readStatus(entry)
      if (status === "active") {
        const n = await this.pushEntry(entry)
        pushed++
        chunkCount += n
      } else if (status === "deprecated" || status === "archived") {
        const slug = entry.frontmatter.slug
        if (typeof slug === "string") {
          const r = await this.opts.writer.removeEntry(slug)
          removed += r.removed > 0 ? 1 : 0
        }
      } else {
        skipped++
      }
    }
    return { pushed, removed, skipped, chunkCount, sourcesPushed }
  }

  /**
   * Re-sync a single entry by slug. The lifecycle's `promote`
   * workflow calls this immediately after writing the entry file.
   */
  async syncEntry(
    snapshot: CorpusWorkspaceSnapshot,
    slug: string
  ): Promise<{ chunkCount: number }> {
    const entry = snapshot.entries.find((e) => e.frontmatter.slug === slug)
    if (!entry) {
      // Missing slug = deprecated/erased; drop from backing engine.
      await this.opts.writer.removeEntry(slug)
      return { chunkCount: 0 }
    }
    const status = readStatus(entry)
    if (status !== "active") {
      await this.opts.writer.removeEntry(slug)
      return { chunkCount: 0 }
    }
    // Always remove-then-push for syncEntry — backing engine doesn't
    // have an "upsert by entrySlug" op. This keeps the chunk set
    // consistent with the current entry body.
    await this.opts.writer.removeEntry(slug)
    const n = await this.pushEntry(entry)
    return { chunkCount: n }
  }

  /** Drop one entry from the backing engine (deprecation, GDPR erase). */
  async removeEntry(slug: string): Promise<void> {
    await this.opts.writer.removeEntry(slug)
  }

  // ── Internal ─────────────────────────────────────────────────────

  private async pushEntry(entry: ParsedFile): Promise<number> {
    const slug = entry.frontmatter.slug
    if (typeof slug !== "string") return 0
    const chunks = chunkText(entry.body, this.opts.chunker).map((text) => ({
      text,
    }))
    const corpus = readCorpusMetadata(entry)
    await this.opts.writer.pushChunks({
      entrySlug: slug,
      entryPath: entry.path,
      title: typeof entry.frontmatter.title === "string"
        ? entry.frontmatter.title
        : undefined,
      chunks,
      // Forward the corpus-namespaced metadata so the engine adapter
      // can hydrate hits without re-reading the file.
      entryMetadata: {
        kind: entry.frontmatter.kind,
        sources: entry.frontmatter.sources,
        confidence: entry.frontmatter.confidence,
        tags: entry.frontmatter.tags,
        ...corpus,
      },
      // Full frontmatter for a graph-projection writer (relation arrays the
      // flattened entryMetadata drops). Vector engines ignore it.
      entryFrontmatter: entry.frontmatter,
    })
    return chunks.length
  }
}

function readStatus(entry: ParsedFile): string {
  const corpus = (entry.frontmatter.metadata as { corpus?: { status?: unknown } })
    ?.corpus
  const s = corpus?.status
  return typeof s === "string" ? s : "active"
}

function readCorpusMetadata(
  entry: ParsedFile
): Readonly<Record<string, unknown>> {
  const corpus = (entry.frontmatter.metadata as { corpus?: unknown })?.corpus
  return (corpus as Readonly<Record<string, unknown>>) ?? {}
}
