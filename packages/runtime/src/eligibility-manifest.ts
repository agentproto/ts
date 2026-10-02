/**
 * The (adapter × route × model) → eligibility-manifest projection — the single
 * authority the spawn path (`resolveAccessProfileAuth`, `session-spawn.ts`) and
 * the read-only catalog (`buildCatalogModels`, `catalog-models.ts`) both
 * compute per-route `eligibleProfiles` through.
 *
 * Extracted from `session-spawn.ts` so `catalog-models.ts` can reuse it
 * WITHOUT a module cycle: `session-spawn.ts` imports the model/route guards
 * from `catalog-models.ts`, so `catalog-models.ts` must not import
 * `session-spawn.ts` back. This module depends only on `spawn-defaults.ts` +
 * `@agentproto/model-catalog/llm`, which both already sit below the catalog.
 */

import type { AuthMethod, AdapterAuthManifest } from "@agentproto/auth"
import { getModelProvider } from "@agentproto/model-catalog/llm"
import {
  modelIdPrefixProvider,
  subscriptionSurfaceFor,
  type AdapterAuthDescriptor,
} from "./spawn-defaults.js"
import type { RouteSpec } from "./session-config.js"

function directAuthMethods(
  descriptor: AdapterAuthDescriptor | undefined,
  endpoint?: string,
): AuthMethod[] {
  const methods: AuthMethod[] = []
  // oauth-bearer requires an explicit, provider-matching subscription
  // surface — `modelDerivedApiKey` alone no longer implies it (that
  // assumption injected subscription OATs into x-api-key vars; see
  // `subscriptionSurfaceFor`'s doc in spawn-defaults.ts).
  if (subscriptionSurfaceFor(descriptor?.authSubscription, endpoint) !== undefined) {
    methods.push("oauth-bearer")
  }
  if (descriptor?.provider || descriptor?.modelDerivedApiKey) methods.push("api-key")
  return methods
}

/** Build the one-route eligibility projection used for an initial spawn AND
 *  for a restart / resume (`session-restart-core.ts` imports this rather than
 *  keeping a mirror — its old copy drifted and lost the `modelProviders` /
 *  `modelIdPrefixProvider` tiers, so an `opencode-go/<id>` session with no
 *  persisted route could spawn but never restart). A gateway bills the gateway
 *  endpoint and accepts only its API key; a direct route uses the adapter's
 *  native auth vocabulary. */
export function spawnEligibilityManifest(
  adapter: string,
  descriptor: AdapterAuthDescriptor | undefined,
  route: RouteSpec | undefined,
  model: string | undefined,
): { manifest: AdapterAuthManifest; routeId: string; direct: boolean } | undefined {
  // Endpoint precedence: adapter's FIXED provider (single-provider adapters)
  // > the adapter's OWN declared per-model provider (`modelProviders`, a
  // model-derived-api-key adapter's `models.allowed[].provider` — the
  // authoritative statement of who bills THIS adapter for THIS model) > the
  // GLOBAL catalog's model→provider derivation. The middle tier exists
  // because a model-derived adapter has no fixed `provider` at all, so
  // without it the catalog fallback is the ONLY signal — and the catalog's
  // route for a given model id is a global fact that can legitimately differ
  // from what one specific adapter actually bills it through (D3: pi bills
  // `moonshotai/kimi-k2.7-code` via `moonshot`, but the catalog routes that
  // id to `openrouter`).
  const directEndpoint =
    descriptor?.provider ??
    (model ? descriptor?.modelProviders?.[model] : undefined) ??
    (model && descriptor?.modelDerivedApiKey
      ? modelIdPrefixProvider(model)
      : undefined) ??
    (model ? getModelProvider(model) : undefined)
  const routeId = route?.gateway ?? directEndpoint
  if (!routeId) return undefined
  const direct = directEndpoint !== undefined && routeId === directEndpoint
  return {
    manifest: {
      id: adapter,
      endpointByRoute: { [routeId]: direct ? directEndpoint : routeId },
      methodsByRoute: {
        [routeId]: direct ? directAuthMethods(descriptor, directEndpoint) : ["api-key"],
      },
    },
    routeId,
    direct,
  }
}
