/**
 * provider-kit family wiring for the qdrant knowledge backend.
 *
 * The studio home-grown `createEngineRegistry`-based knowledge registry is NOT
 * ported (it was the guild resolution layer, which stays studio-side per the
 * Ph4 plan — the studio `qdrant/descriptor` recursively resolves per-KB config
 * + reveals the vault secret through that registry). Instead the qdrant backend
 * registers as a provider-kit family (`TInfo = KnowledgeQdrantInfo`, `THandle =
 * KnowledgeHandle extends AdapterHandle`), reusing the exact consumer shape the
 * code-brain + files + corpus adapters established — catalog + resolver + a
 * safe `info()` descriptor that NEVER carries a secret. Discovery flows through
 * the kit's `@agentproto/adapter-knowledge-*` naming convention.
 *
 * Unlike the zero-setup files/corpus handles, qdrant needs a Qdrant endpoint +
 * an embeddings API key, so `requiresSetup` / `authRequired` are both true and
 * `provider()` (via {@link createStandaloneQdrantAdapter}) throws when the
 * `QDRANT_URL` / `OPENAI_API_KEY` env is absent.
 */

import type { IKnowledgeProvider } from "@agentproto/knowledge-engine"
import {
  makeAdapterResolver,
  type AdapterHandle,
  type AdapterResolver,
} from "@agentproto/provider-kit"
import { KNOWLEDGE_QDRANT_CATALOG, QDRANT_SLUG } from "./catalog.js"
import { createStandaloneQdrantAdapter } from "./standalone.js"

/** Safe descriptor for a knowledge backend — NEVER carries a secret. */
export interface KnowledgeQdrantInfo {
  readonly slug: string
  /** The retrieval engine this backend uses. */
  readonly engine: "qdrant"
  readonly capabilities: {
    /** True — qdrant performs dense/vector retrieval. */
    readonly vectorSearch: boolean
    /** True — qdrant needs a Qdrant endpoint + an embeddings API key. */
    readonly needsCreds: boolean
  }
}

/** A resolved knowledge backend handle. */
export interface KnowledgeHandle extends AdapterHandle {
  /** Safe descriptor — NEVER a secret. */
  info(): KnowledgeQdrantInfo
  /**
   * Build the live {@link IKnowledgeProvider} from the ambient `QDRANT_*` /
   * `OPENAI_*` env. Throws when the required env is absent — construction-time
   * failure is clearer than a connection error on the first query.
   */
  provider(): IKnowledgeProvider
}

/**
 * Resolve a catalog slug to a concrete knowledge handle. Throws for unknown
 * slugs so the kit's resolver wrapper folds the miss to `null`. `provider()`
 * is lazy — the `QDRANT_URL` / `OPENAI_API_KEY` requirement is enforced only
 * when a provider is actually built, not at resolution time.
 */
export function resolveKnowledgeBackend(slug: string): KnowledgeHandle {
  const catalogEntry = KNOWLEDGE_QDRANT_CATALOG.find(
    (entry) => entry.slug === slug,
  )
  if (catalogEntry === undefined) {
    throw new Error(`unknown knowledge backend slug: ${slug}`)
  }

  switch (slug) {
    case QDRANT_SLUG: {
      return {
        slug,
        name: catalogEntry.name,
        description: catalogEntry.description,
        version: "0.1.0",
        requiresSetup: true,
        authRequired: true,
        // Health probe: build from env + hit GET /collections/{name}. When the
        // env is absent, construction throws — fold that to "not reachable"
        // rather than propagating so a listing probe stays total.
        check: async () => {
          try {
            return await createStandaloneQdrantAdapter().healthCheck()
          } catch {
            return false
          }
        },
        info() {
          return {
            slug,
            engine: "qdrant",
            capabilities: { vectorSearch: true, needsCreds: true },
          }
        },
        provider: () => createStandaloneQdrantAdapter(),
      }
    }
  }

  throw new Error(`unhandled knowledge backend slug: ${slug}`)
}

/**
 * Build the knowledge resolver: resolves a catalog slug to a handle, returning
 * `null` when the slug is unknown (via the kit's wrapper).
 */
export function makeKnowledgeQdrantResolver(): AdapterResolver<KnowledgeHandle> {
  return makeAdapterResolver<KnowledgeHandle>({
    load: async (slug: string): Promise<KnowledgeHandle> =>
      resolveKnowledgeBackend(slug),
  })
}
