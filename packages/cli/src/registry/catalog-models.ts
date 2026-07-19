/**
 * Real-adapter shim for `@agentproto/runtime`'s `buildCatalogModels`
 * (SPEC §5) — the `listCatalogModels` the daemon's `GET /catalog/models`
 * + `catalog_models` MCP tool are wired to (`serve.ts`).
 *
 * Reuses the exact same installed-adapter listing `agentproto models`
 * already builds (`listAdaptersWithCatalog`, `models.ts:90`) plus the
 * adapter's billing-auth projection (`toAuthDescriptor`, this module) and
 * `@agentproto/auth`'s real named-profile store (`listAuthProfiles`) — the
 * generalization of the bare provider-key `hasKey` check `models.ts` used
 * (`models.ts:113-117`).
 */

import { listAuthProfiles } from "@agentproto/auth"
import {
  buildCatalogModels,
  type CatalogAdapterInput,
  type CatalogModelsQuery,
  type CatalogModelsResponse,
} from "@agentproto/runtime"
import { CATALOG } from "./catalog.js"
import { listAdaptersWithCatalog, resolveAdapter, toAuthDescriptor } from "./resolve.js"

export async function listCatalogModelsFromInstalled(
  query: CatalogModelsQuery,
): Promise<CatalogModelsResponse> {
  const installed = await listAdaptersWithCatalog(CATALOG)
  const adapters: CatalogAdapterInput[] = await Promise.all(
    installed
      .filter(a => a.modelDetails.length > 0)
      .map(async a => {
        // Best-effort — an adapter that fails to re-resolve here (mid
        // rebuild, see `resolveAdapter`'s doc) just contributes no auth
        // descriptor rather than dropping its models from the catalog.
        const authDescriptor = await resolveAdapter(a.slug)
          .then(r => toAuthDescriptor(r.handle))
          .catch(() => undefined)
        return {
          slug: a.slug,
          models: a.modelDetails.map(m => ({
            id: m.id,
            ...(m.mode ? { mode: m.mode } : {}),
          })),
          ...(authDescriptor ? { authDescriptor } : {}),
        }
      }),
  )
  const profiles = await listAuthProfiles()
  return buildCatalogModels({ adapters, profiles, query })
}
