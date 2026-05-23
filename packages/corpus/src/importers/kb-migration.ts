/**
 * KbMigrationImporter — turn an existing knowledge base into a
 * stream of `ImportedSource` for the runner.
 *
 * Use case: a guild already has a populated qdrant/gbrain KB row
 * with N documents. Day-1 corpus onboarding shouldn't be "abandon
 * your knowledge and start over" — this importer reads the source
 * KB via its IKnowledgeProvider, materializes each source as an
 * importable, and the runner archives them into `sources/` +
 * appends candidates. The source KB stays intact (read-only).
 *
 * The minimal IKnowledgeProvider-like shape we consume — keeps the
 * kit decoupled from @agstudio/integration-knowledge.
 *
 * Each migrated source carries `provenanceKind: imported-from-kb`
 * and `sourceKbId` in `metadata.corpus` so curators can trace which
 * KB row each item came from.
 */

import { createHash } from "node:crypto"
import type {
  CorpusImporter,
  ImportedSource,
  ImporterTarget,
} from "./types.js"

/**
 * Structural shape — any IKnowledgeProvider satisfies it. We don't
 * import IKnowledgeProvider directly to keep the kit dep-free.
 */
export interface KbListLike {
  listSources(): Promise<readonly KbSourceLike[]>
}

export interface KbSourceLike {
  readonly id: string
  readonly kind: string
  readonly uri: string
  readonly title?: string
  readonly bytes: number
  readonly metadata: Readonly<Record<string, unknown>>
}

export interface KbMigrationConfig {
  /** Stable id of the source KB (used in provenance + archive path). */
  readonly sourceKbId: string
  /** Live provider instance from the source KB. */
  readonly provider: KbListLike
  /**
   * Optional fetcher for the body of each source. The migration
   * importer enumerates source METADATA from listSources(); to
   * archive the actual content, the host must supply a way to fetch
   * the body. If omitted, sources are imported with an empty body +
   * a note pointing back to the source KB.
   */
  readonly fetchBody?: (sourceId: string) => Promise<string>
  /** Optional max sources to import this batch. */
  readonly maxSources?: number
}

export class KbMigrationImporter implements CorpusImporter {
  readonly id = "kb-migration"
  readonly label = "Migrate from existing KB"

  async *enumerate(target: ImporterTarget): AsyncIterable<ImportedSource> {
    const config = parseKbMigrationConfig(target.config)
    const sources = await config.provider.listSources()
    const max = config.maxSources ?? sources.length
    let yielded = 0
    for (const s of sources) {
      if (yielded >= max) break
      const body = config.fetchBody
        ? await config.fetchBody(s.id)
        : `(Migrated from KB ${config.sourceKbId}, source id=${s.id}. Body fetcher not configured — archive contains metadata only.)`
      const slug = slugifyKbSource(s.id, config.sourceKbId)
      yield {
        slug,
        title: s.title ?? s.id,
        contentHash: hashKbSource(s, body),
        body,
        originalUrl: typeof s.uri === "string" ? s.uri : undefined,
        authority: "secondary",
        corpusMetadata: {
          provenanceKind: "imported-from-kb",
          sourceKbId: config.sourceKbId,
          sourceKbSourceId: s.id,
          sourceKbBytes: s.bytes,
          sourceKbKind: s.kind,
          // Carry the original KB's metadata through verbatim so
          // curators can see what was lost in translation.
          sourceKbMetadata: s.metadata,
        },
      }
      yielded++
    }
  }
}

// ── Helpers ─────────────────────────────────────────────────────────

function parseKbMigrationConfig(
  raw: Readonly<Record<string, unknown>>
): KbMigrationConfig {
  const sourceKbId = raw.sourceKbId
  const provider = raw.provider
  if (typeof sourceKbId !== "string") {
    throw new Error("KbMigrationImporter: config.sourceKbId required (string)")
  }
  if (!provider || typeof provider !== "object" || typeof (provider as KbListLike).listSources !== "function") {
    throw new Error(
      "KbMigrationImporter: config.provider required (must implement listSources)"
    )
  }
  return {
    sourceKbId,
    provider: provider as KbListLike,
    fetchBody:
      typeof raw.fetchBody === "function"
        ? (raw.fetchBody as (id: string) => Promise<string>)
        : undefined,
    maxSources:
      typeof raw.maxSources === "number" ? raw.maxSources : undefined,
  }
}

function slugifyKbSource(id: string, kbId: string): string {
  // Prefix with kbId so two KBs migrating sources with overlapping
  // ids don't collide in `sources/<importer>/<batch>/`.
  const combined = `${kbId}-${id}`
  const slug = combined
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-")
    .slice(0, 96)
  return slug || "migrated-source"
}

function hashKbSource(s: KbSourceLike, body: string): string {
  // Stable hash so the dedup gate works across reruns of the same
  // KB. Uses node:crypto for parity with reader.ts; Bun/Deno also
  // ship node:crypto in their stdlib.
  return (
    "sha256:" +
    createHash("sha256")
      .update(`${s.id}|${s.bytes}|${body}`)
      .digest("hex")
  )
}
