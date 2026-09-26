/**
 * Real-adapter shim for `@agentproto/runtime`'s `buildCatalogModels`
 * (SPEC §5) — the `listCatalogModels` the daemon's `GET /catalog/models`
 * + `catalog_models` MCP tool are wired to (`serve.ts`).
 *
 * Reuses the same merged adapter listing `adapter_list` serves
 * (`listAdaptersWithAcp` — npm/native catalog + generic ACP) plus the
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
import { listAdaptersWithAcp, resolveAdapter, toAuthDescriptor } from "./resolve.js"

export async function listCatalogModelsFromInstalled(
  query: CatalogModelsQuery,
): Promise<CatalogModelsResponse> {
  // The MERGED listing (native + generic ACP), not just the npm/native
  // catalog: a generic-ACP catalog entry with curated `models` (kimi-cli,
  // mistral-vibe) must reach the catalog join too, or the adapter-capability
  // spawn guard (`checkModelAdapterEligibility`) rejects that adapter's OWN
  // manifest default model as "not declared". A generic entry is listed even
  // when its bin is absent (`status: "supported"`), so gate on "ready" —
  // the same installed-only bar a native adapter clears by resolving
  // (an unresolved native entry has no modelDetails and self-excludes).
  const installed = await listAdaptersWithAcp(CATALOG)
  const adapters: CatalogAdapterInput[] = await Promise.all(
    installed
      .filter(a => a.modelDetails.length > 0)
      .filter(a => a.source === undefined || a.status === "ready")
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
            ...(m.provider ? { provider: m.provider } : {}),
            ...(m.mode ? { mode: m.mode } : {}),
          })),
          ...(authDescriptor ? { authDescriptor } : {}),
          ...(a.routeSelection ? { routeSelection: a.routeSelection } : {}),
        }
      }),
  )
  const profiles = await listAuthProfiles()
  return buildCatalogModels({ adapters, profiles, query })
}
