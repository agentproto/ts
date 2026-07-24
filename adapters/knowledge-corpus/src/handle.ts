/**
 * provider-kit family wiring for the corpus knowledge backend.
 *
 * The studio home-grown `createEngineRegistry`-based knowledge registry is
 * NOT ported (it was the guild resolution layer, which stays studio-side per
 * the Ph4 plan — the studio `corpus/descriptor.ts` recursively resolves a
 * backing engine through that registry and carries the Settings-UI `fields`).
 * Instead the corpus backend registers as a provider-kit family (`TInfo =
 * KnowledgeCorpusInfo`, `THandle = KnowledgeHandle extends AdapterHandle`),
 * reusing the exact consumer shape the code-brain + files adapters established
 * — catalog + resolver + a safe `info()` descriptor. Discovery flows through
 * the kit's `@agentproto/adapter-knowledge-*` naming convention.
 *
 * The corpus engine is a COMPOSITION wrapper, so its `provider()` accepts the
 * backing `IKnowledgeProvider` to wrap (defaults to a no-op empty backing —
 * see `./empty-backing.ts`). This is the one place the corpus handle's shape
 * diverges from the files handle's zero-arg `provider()`.
 */

import type { IKnowledgeProvider } from "@agentproto/knowledge-engine"
import {
  makeAdapterResolver,
  type AdapterHandle,
  type AdapterResolver,
} from "@agentproto/provider-kit"
import { CORPUS_SLUG, KNOWLEDGE_CORPUS_CATALOG } from "./catalog.js"
import {
  createStandaloneCorpusAdapter,
  type CreateStandaloneCorpusAdapterOptions,
} from "./standalone.js"

/** Safe descriptor for a knowledge backend — NEVER carries a secret. */
export interface KnowledgeCorpusInfo {
  readonly slug: string
  /** The retrieval engine this backend uses. */
  readonly engine: "corpus"
  /** True — corpus wraps a backing engine rather than storing vectors itself. */
  readonly composable: boolean
  readonly capabilities: {
    /** True when the backend performs dense/vector retrieval. Depends on backing. */
    readonly vectorSearch: boolean
    /** True when the backend needs a credential to authenticate. */
    readonly needsCreds: boolean
  }
}

/** A resolved knowledge backend handle. */
export interface KnowledgeHandle extends AdapterHandle {
  /** Safe descriptor — NEVER a secret. */
  info(): KnowledgeCorpusInfo
  /**
   * Build the live {@link IKnowledgeProvider}. The corpus engine is a
   * composition wrapper — pass the backing engine to wrap (the files
   * adapter, or an external vector store). Omit it to wrap a no-op empty
   * backing (workspace-direct read
   * paths + health probe only).
   */
  provider(opts?: CreateStandaloneCorpusAdapterOptions): IKnowledgeProvider
}

/**
 * Resolve a catalog slug to a concrete knowledge handle. Throws for unknown
 * slugs so the kit's resolver wrapper folds the miss to `null`. `provider()`
 * builds a fresh standalone corpus adapter per call (each with its own
 * workspace snapshot state) — callers that want a shared warm snapshot should
 * hold onto the returned provider.
 */
export function resolveKnowledgeBackend(slug: string): KnowledgeHandle {
  const catalogEntry = KNOWLEDGE_CORPUS_CATALOG.find(
    entry => entry.slug === slug
  )
  if (catalogEntry === undefined) {
    throw new Error(`unknown knowledge backend slug: ${slug}`)
  }

  switch (slug) {
    case CORPUS_SLUG: {
      const provider = (
        opts?: CreateStandaloneCorpusAdapterOptions
      ): IKnowledgeProvider => createStandaloneCorpusAdapter(opts)
      return {
        slug,
        name: catalogEntry.name,
        description: catalogEntry.description,
        version: "0.1.0",
        // No creds of its own — corpus reads a local AIP-10 workspace and
        // wraps a backing engine. Live retrieval needs a backing supplied to
        // `provider()`, but the engine itself has nothing to set up.
        requiresSetup: false,
        // Health probes the no-op empty backing wrap: workspace reachable +
        // backing healthy.
        check: () => provider().healthCheck(),
        info() {
          return {
            slug,
            engine: "corpus",
            composable: true,
            // Vector search is a property of the wrapped backing engine, not
            // corpus itself; report false for the standalone default.
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
export function makeKnowledgeCorpusResolver(): AdapterResolver<KnowledgeHandle> {
  return makeAdapterResolver<KnowledgeHandle>({
    load: async (slug: string): Promise<KnowledgeHandle> =>
      resolveKnowledgeBackend(slug),
  })
}
