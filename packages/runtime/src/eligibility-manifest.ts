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

import {
  eligibleProfiles,
  resolveEndpoint,
  type AuthMethod,
  type AuthProfile,
  type AdapterAuthManifest,
} from "@agentproto/auth"
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

const OPENCODE_CONSOLE_SOURCE = "opencode-console"
const OPENCODE_GO_ENDPOINT = "opencode-go"
const OPENCODE_ZEN_ENDPOINT = "opencode"

function isOpencodeConsoleOrgProfile(profile: AuthProfile): boolean {
  return (
    profile.source === OPENCODE_CONSOLE_SOURCE &&
    profile.subaccount?.kind === "org" &&
    (profile.endpoint === OPENCODE_GO_ENDPOINT || profile.endpoint === OPENCODE_ZEN_ENDPOINT)
  )
}

/** `eligibleProfiles` plus the one cross-endpoint rule: an OpenCode console
 *  org login is a single login serving BOTH the `opencode-go` and `opencode`
 *  (Zen) routes. Zen bills the org's pay-as-you-go wallet for paid ids, so on
 *  the `opencode` route such a profile is eligible only when it carries an
 *  explicit `models.mode: "allow"` list containing the route-qualified id
 *  (`opencode/<id>`) being requested. Every other profile is judged by the
 *  plain endpoint/method predicate. `model` is the requested model id. */
export function eligibleProfilesForRoute(
  profiles: readonly AuthProfile[],
  manifest: AdapterAuthManifest,
  route: string,
  model: string | undefined,
): AuthProfile[] {
  const { endpoint } = resolveEndpoint(manifest, route)
  const zenId =
    model === undefined ? undefined : model.startsWith(`${OPENCODE_ZEN_ENDPOINT}/`) ? model : `${OPENCODE_ZEN_ENDPOINT}/${model}`
  const pairs: Array<{ original: AuthProfile; judged: AuthProfile }> = []
  for (const original of profiles) {
    if (!isOpencodeConsoleOrgProfile(original) || (endpoint !== OPENCODE_GO_ENDPOINT && endpoint !== OPENCODE_ZEN_ENDPOINT)) {
      pairs.push({ original, judged: original })
      continue
    }
    if (endpoint === OPENCODE_ZEN_ENDPOINT) {
      const allowed =
        original.models?.mode === "allow" && zenId !== undefined && original.models.ids.includes(zenId)
      if (!allowed) continue
    }
    pairs.push({ original, judged: { ...original, endpoint } })
  }
  const ok = new Set(eligibleProfiles(pairs.map(pair => pair.judged), manifest, route))
  return pairs.filter(pair => ok.has(pair.judged)).map(pair => pair.original)
}
