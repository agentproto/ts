/**
 * provider-kit family wiring for the files knowledge backend.
 *
 * The studio home-grown `createEngineRegistry`-based knowledge registry is
 * NOT ported (it was the guild resolution layer, which stays studio-side per
 * the Ph4 plan). Instead the files backend registers as a provider-kit family
 * (`TInfo = KnowledgeFilesInfo`, `THandle = KnowledgeHandle extends
 * AdapterHandle`), reusing the exact consumer shape the code-brain adapter
 * established — catalog + resolver + a safe `info()` descriptor. Discovery
 * flows through the kit's `@agentproto/adapter-knowledge-*` naming convention.
 */

import type { IKnowledgeProvider } from "@agentproto/knowledge-engine"
import {
  makeAdapterResolver,
  type AdapterHandle,
  type AdapterResolver,
} from "@agentproto/provider-kit"
import { FILES_BM25_SLUG, KNOWLEDGE_FILES_CATALOG } from "./catalog.js"
import { createStandaloneFilesAdapter } from "./standalone.js"

/** Safe descriptor for a knowledge backend — NEVER carries a secret. */
export interface KnowledgeFilesInfo {
  readonly slug: string
  /** The retrieval engine this backend uses. */
  readonly engine: "bm25"
  readonly capabilities: {
    /** True when the backend performs dense/vector retrieval. */
    readonly vectorSearch: boolean
    /** True when the backend needs a credential to authenticate. */
    readonly needsCreds: boolean
  }
}

/** A resolved knowledge backend handle. */
export interface KnowledgeHandle extends AdapterHandle {
  /** Safe descriptor — NEVER a secret. */
  info(): KnowledgeFilesInfo
  /** Build the live {@link IKnowledgeProvider}. */
  provider(): IKnowledgeProvider
}

/**
 * Resolve a catalog slug to a concrete knowledge handle. Throws for unknown
 * slugs so the kit's resolver wrapper folds the miss to `null`. `provider()`
 * is lazy and caches a single standalone adapter — repeated calls share one
 * warm BM25 index rather than each cold-building their own.
 */
export function resolveKnowledgeBackend(slug: string): KnowledgeHandle {
  const catalogEntry = KNOWLEDGE_FILES_CATALOG.find(
    entry => entry.slug === slug
  )
  if (catalogEntry === undefined) {
    throw new Error(`unknown knowledge backend slug: ${slug}`)
  }

  switch (slug) {
    case FILES_BM25_SLUG: {
      // Lazily built + cached so every provider() call shares one warm index.
      let cached: IKnowledgeProvider | null = null
      const provider = (): IKnowledgeProvider =>
        (cached ??= createStandaloneFilesAdapter())
      return {
        slug,
        name: catalogEntry.name,
        description: catalogEntry.description,
        version: "0.1.0",
        // No creds, no external service — indexing the local workspace works
        // out of the box, so there is nothing to set up.
        requiresSetup: false,
        check: () => provider().healthCheck(),
        info() {
          return {
            slug,
            engine: "bm25",
            capabilities: { vectorSearch: false, needsCreds: false },
          }
        },
        provider,
      }
    }
  }

  throw new Error(`unhandled knowledge backend slug: ${slug}`)
}

/**
 * Build the knowledge resolver: resolves a catalog slug to a handle,
 * returning `null` when the slug is unknown (via the kit's wrapper).
 */
export function makeKnowledgeFilesResolver(): AdapterResolver<KnowledgeHandle> {
  return makeAdapterResolver<KnowledgeHandle>({
    load: async (slug: string): Promise<KnowledgeHandle> =>
      resolveKnowledgeBackend(slug),
  })
}
