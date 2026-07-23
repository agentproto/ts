/**
 * (adapter × route) → billing-endpoint resolution + the profile eligibility predicate
 * (SPEC §1c, `agentproto-session-config-axes/SPEC.md:102-125`).
 *
 *   profile eligible for (adapter, route) iff
 *        profile.endpoint == resolveEndpoint(adapter, route).endpoint
 *    AND profile.method  ∈ methodsPresentable(adapter, route)
 *
 * `route` is the endpoint selector (SPEC axis #4 — direct vs a gateway mode
 * like `moonshot`/`openrouter`), so access is deliberately downstream of it:
 * which endpoint (and thus which profiles) are eligible changes when route
 * changes. `AdapterAuthManifest` is a narrow, package-local projection of
 * exactly what this predicate needs from an adapter's real AIP-45 manifest
 * (`packages/driver/agent-cli/src/types.ts`'s `AgentCliDefinition`) — this
 * package intentionally does not depend on `@agentproto/driver-agent-cli`
 * (wrong dependency direction; drivers consume auth, not vice versa), so the
 * runtime is the one that will later project a real manifest into this
 * shape (out of scope here — foundation only, no live spawn-path wiring).
 *
 * `methodsByRoute` is the static per-endpoint method table ADR'd in SPEC §3.4:
 * "which auth methods this adapter can present for a resolved route." It is
 * the derivable replacement for two hand-maintained artifacts SPEC §1c calls
 * out for eventual removal — the per-adapter `authSubscription` boolean
 * (`adapters/claude-code/src/index.ts:90-95`) and curatorial vendor deny
 * lists (`adapters/hermes/HERMES.md:40-42`) — neither of which this PR
 * touches; `authSubscription` stays exactly as-is (see the comment on it in
 * `spawn-defaults.ts:345` — this module is additive, not a replacement).
 *
 * ACP `authenticate` is NOT a live discovery source for this table (the
 * server handler is a stub, `packages/acp/src/server/index.ts:69`) — method
 * discovery is this static table, not runtime negotiation (SPEC §3.7).
 */

import type { AuthMethod, AuthProfile } from "./profile-types.js"

/** A narrow, package-local projection of an adapter's declared auth
 *  capability — enough to resolve (adapter, route) → endpoint and the auth
 *  methods presentable on that route. Not the real AIP-45 manifest type. */
export interface AdapterAuthManifest {
  /** Adapter id (e.g. "claude-code", "hermes"), for error messages only. */
  id: string
  /** route id (e.g. "direct", or a gateway mode id like "moonshot") →
   *  the billing endpoint used when spawned on that route. */
  endpointByRoute: Readonly<Record<string, string>>
  /** route id → the auth methods this adapter can present when spawned on
   *  that route — the method-side of the eligibility predicate. */
  methodsByRoute: Readonly<Record<string, readonly AuthMethod[]>>
}

/** Resolve which billing endpoint a given (adapter, route) pair uses. Throws
 *  when the manifest declares no endpoint for `route` — an unresolvable route
 *  is a caller bug (a bad/unknown route id), not a "no profiles eligible"
 *  case, so this fails loud rather than returning an empty endpoint. */
export function resolveEndpoint(
  manifest: AdapterAuthManifest,
  route: string,
): { endpoint: string } {
  const endpoint = manifest.endpointByRoute[route]
  if (endpoint === undefined) {
    throw new Error(
      `resolveEndpoint: adapter "${manifest.id}" declares no endpoint for route "${route}"`,
    )
  }
  return { endpoint }
}

/** Which auth methods `manifest`'s adapter can present on `route`. Empty
 *  (never throws) when the route is declared for vendor resolution but has
 *  no methods table entry — that's "no eligible profiles", a legitimate
 *  eligibility outcome, not an error. */
export function methodsPresentable(
  manifest: AdapterAuthManifest,
  route: string,
): AuthMethod[] {
  return [...(manifest.methodsByRoute[route] ?? [])]
}

/** The eligibility predicate: profiles whose endpoint matches the route's
 *  resolved endpoint AND whose method the adapter can present on that route.
 *  A whole-profile-disabled profile (`disabled: true`) is skipped outright —
 *  every model it would otherwise service drops to non-runnable (WS2). This is
 *  the profile-level gate; per-model curation (`models`) is intersected
 *  downstream in the catalog join, not here (SPEC §1c / catalog-models.ts). */
export function eligibleProfiles(
  profiles: readonly AuthProfile[],
  manifest: AdapterAuthManifest,
  route: string,
): AuthProfile[] {
  const { endpoint } = resolveEndpoint(manifest, route)
  const methods = methodsPresentable(manifest, route)
  return profiles.filter(
    p => !p.disabled && p.endpoint === endpoint && methods.includes(p.method),
  )
}
