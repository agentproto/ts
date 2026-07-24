/**
 * provider-kit family wiring for the code-brain backends.
 *
 * Studio's home-grown `createEngineRegistry`-based knowledge registry is NOT
 * ported. Instead the two gbrain backends register as a provider-kit family
 * (`TInfo = CodeBrainInfo`, `THandle = CodeBrainHandle extends AdapterHandle`),
 * reusing the exact consumer shape `@agentproto/eval-reporters` established —
 * catalog + resolver + a safe `info()` descriptor that never carries a
 * secret. Discovery flows through the kit's `@agentproto/adapter-code-brain-*`
 * naming convention.
 */

import {
  makeAdapterResolver,
  type AdapterHandle,
  type AdapterResolver,
} from "@agentproto/provider-kit"
import type { ICodeBrainProvider } from "@agentproto/code-brain"
import {
  CODE_BRAIN_CATALOG,
  GBRAIN_HTTP_SLUG,
  GBRAIN_LOCAL_SLUG,
} from "./catalog.js"
import { gbrainLocalProvider } from "./gbrain-local.js"
import { gbrainHttpProvider } from "./gbrain-http.js"

/** Safe descriptor for a code-brain backend — NEVER carries a secret. */
export interface CodeBrainInfo {
  readonly slug: string
  /** How the backend reaches gbrain. */
  readonly transport: "docker-exec" | "http"
  readonly capabilities: {
    /** True when the backend needs a bearer/credential to authenticate. */
    readonly needsCreds: boolean
  }
}

/** A resolved code-brain backend handle. */
export interface CodeBrainHandle extends AdapterHandle {
  /** Safe descriptor — NEVER a secret. */
  info(): CodeBrainInfo
  /** Build the live {@link ICodeBrainProvider}. */
  provider(): ICodeBrainProvider
}

/**
 * Resolve a catalog slug to a concrete code-brain handle. Throws for unknown
 * slugs so the kit's resolver wrapper folds the miss to `null`. `provider()`
 * is lazy — the HTTP backend's `GBRAIN_BEARER_TOKEN` requirement is enforced
 * only when a provider is actually built, not at resolution time.
 */
export function resolveCodeBrainBackend(slug: string): CodeBrainHandle {
  const catalogEntry = CODE_BRAIN_CATALOG.find((entry) => entry.slug === slug)
  if (catalogEntry === undefined) {
    throw new Error(`unknown code-brain backend slug: ${slug}`)
  }

  switch (slug) {
    case GBRAIN_LOCAL_SLUG: {
      const provider = gbrainLocalProvider()
      return {
        slug,
        name: catalogEntry.name,
        description: catalogEntry.description,
        version: "0.1.0",
        requiresSetup: false,
        check: () => provider.check(),
        info() {
          return { slug, transport: "docker-exec", capabilities: { needsCreds: false } }
        },
        provider() {
          return provider
        },
      }
    }
    case GBRAIN_HTTP_SLUG: {
      return {
        slug,
        name: catalogEntry.name,
        description: catalogEntry.description,
        version: "0.1.0",
        requiresSetup: true,
        authRequired: true,
        check: () => gbrainHttpProvider().check(),
        info() {
          return { slug, transport: "http", capabilities: { needsCreds: true } }
        },
        provider() {
          return gbrainHttpProvider()
        },
      }
    }
  }

  throw new Error(`unhandled code-brain backend slug: ${slug}`)
}

/**
 * Build the code-brain resolver: resolves a catalog slug to a handle,
 * returning `null` when the slug is unknown (via the kit's wrapper).
 */
export function makeCodeBrainResolver(): AdapterResolver<CodeBrainHandle> {
  return makeAdapterResolver<CodeBrainHandle>({
    load: async (slug: string): Promise<CodeBrainHandle> => resolveCodeBrainBackend(slug),
  })
}
