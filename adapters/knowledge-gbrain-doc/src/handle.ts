/**
 * provider-kit family wiring for the gbrain-doc knowledge backend.
 *
 * The studio home-grown `createEngineRegistry`-based knowledge registry is NOT
 * ported (it was the guild resolution layer, which stays studio-side per the
 * Ph4 plan — the studio gbrain `descriptor` recursively resolves per-KB config
 * + reveals the vault bearer through that registry, and the retired E2B/sandbox
 * provisioning path stays studio-side too). Instead the gbrain-doc backend
 * registers as a provider-kit family (`TInfo = KnowledgeGbrainDocInfo`, `THandle
 * = KnowledgeHandle extends AdapterHandle`), reusing the exact consumer shape
 * the code-brain + files + corpus + qdrant adapters established — catalog +
 * resolver + a safe `info()` descriptor that NEVER carries a secret. Discovery
 * flows through the kit's `@agentproto/adapter-knowledge-*` naming convention.
 *
 * gbrain-doc needs a gbrain endpoint + a bearer token, so `requiresSetup` /
 * `authRequired` are both true and `provider()` (via
 * {@link createStandaloneGbrainDocAdapter}) throws when `GBRAIN_BEARER_TOKEN` is
 * absent.
 */

import type { IKnowledgeProvider } from "@agentproto/knowledge-engine"
import {
  makeAdapterResolver,
  type AdapterHandle,
  type AdapterResolver,
} from "@agentproto/provider-kit"
import { GBRAIN_DOC_SLUG, KNOWLEDGE_GBRAIN_DOC_CATALOG } from "./catalog.js"
import { createStandaloneGbrainDocAdapter } from "./standalone.js"

/** Safe descriptor for a knowledge backend — NEVER carries a secret. */
export interface KnowledgeGbrainDocInfo {
  readonly slug: string
  /** The retrieval engine this backend uses. */
  readonly engine: "gbrain-doc"
  readonly capabilities: {
    /** True — gbrain fuses lexical + semantic document retrieval. */
    readonly hybridSearch: boolean
    /** True — gbrain-doc needs a gbrain endpoint + a machine bearer token. */
    readonly needsCreds: boolean
  }
}

/** A resolved knowledge backend handle. */
export interface KnowledgeHandle extends AdapterHandle {
  /** Safe descriptor — NEVER a secret. */
  info(): KnowledgeGbrainDocInfo
  /**
   * Build the live {@link IKnowledgeProvider} from the ambient `GBRAIN_*` env.
   * Throws when `GBRAIN_BEARER_TOKEN` is absent — construction-time failure is
   * clearer than a 401 on the first query.
   */
  provider(): IKnowledgeProvider
}

/**
 * Resolve a catalog slug to a concrete knowledge handle. Throws for unknown
 * slugs so the kit's resolver wrapper folds the miss to `null`. `provider()` is
 * lazy — the `GBRAIN_BEARER_TOKEN` requirement is enforced only when a provider
 * is actually built, not at resolution time.
 */
export function resolveKnowledgeBackend(slug: string): KnowledgeHandle {
  const catalogEntry = KNOWLEDGE_GBRAIN_DOC_CATALOG.find(
    (entry) => entry.slug === slug,
  )
  if (catalogEntry === undefined) {
    throw new Error(`unknown knowledge backend slug: ${slug}`)
  }

  switch (slug) {
    case GBRAIN_DOC_SLUG: {
      return {
        slug,
        name: catalogEntry.name,
        description: catalogEntry.description,
        version: "0.1.0",
        requiresSetup: true,
        authRequired: true,
        // Health probe: build from env + hit GET /health. When the env is
        // absent, construction throws — fold that to "not reachable" rather
        // than propagating so a listing probe stays total.
        check: async () => {
          try {
            return await createStandaloneGbrainDocAdapter().healthCheck()
          } catch {
            return false
          }
        },
        info() {
          return {
            slug,
            engine: "gbrain-doc",
            capabilities: { hybridSearch: true, needsCreds: true },
          }
        },
        provider: () => createStandaloneGbrainDocAdapter(),
      }
    }
  }

  throw new Error(`unhandled knowledge backend slug: ${slug}`)
}

/**
 * Build the knowledge resolver: resolves a catalog slug to a handle, returning
 * `null` when the slug is unknown (via the kit's wrapper).
 */
export function makeKnowledgeGbrainDocResolver(): AdapterResolver<KnowledgeHandle> {
  return makeAdapterResolver<KnowledgeHandle>({
    load: async (slug: string): Promise<KnowledgeHandle> =>
      resolveKnowledgeBackend(slug),
  })
}
