/**
 * Auth-profile model curation at the ENFORCEMENT points the catalog join
 * already feeds: the catalog marks a model `runnable` per profile through
 * `profileAllowsModel`, but spawn / live `set_model` never consulted that
 * decision, so a resumed or tool-driven spawn could bill a model the profile
 * explicitly excludes (observed live: `claude-sonnet-5` accepted by a profile
 * whose allow-list names only `claude-sonnet-5-5`).
 *
 * One shared predicate, so the read-only catalog and every write path apply
 * the exact same identity rule:
 *   - route-qualified `ref` (`z-ai/glm-5.2@openrouter`)
 *   - route-independent `vendor/product` (`z-ai/glm-5.2`)
 *   - bare product (`glm-5.2`) ONLY on a direct route (a gateway would
 *     over-widen across sibling vendors)
 * Context-lane hints are not part of identity: `claude-sonnet-5-5[1m]`
 * matches `claude-sonnet-5-5`.
 */

import type { AuthProfile } from "@agentproto/auth"
import { tryParseModelRef } from "@agentproto/model-catalog/route-identity"
import { getModelProvider } from "@agentproto/model-catalog/llm"
import { normalizeRouterPrefixedId } from "./router-routes.js"

const MODEL_CONTEXT_HINT_RE = /\[\d+(?:\.\d+)?[kKmM]\]$/

/** Strip a trailing Claude Code context-lane hint (`[1m]`, `[200k]`). */
export function stripModelContextHint(id: string): string {
  return id.trim().replace(MODEL_CONTEXT_HINT_RE, "")
}

interface ModelIdentity {
  /** The id with any context-lane hint removed. */
  id: string
  vendorProduct?: string
  product: string
  /** Route-qualified ref when the route is a gateway, else vendor/product. */
  ref?: string
  /** Bare-product tolerance is DIRECT-only. */
  direct: boolean
}

function modelIdentity(
  model: string,
  route: string | undefined,
  directOverride: boolean | undefined,
): ModelIdentity {
  const normalized = normalizeRouterPrefixedId(model.trim())
  const parsed = tryParseModelRef(normalized)
  const id = stripModelContextHint(normalized)
  const vendor = parsed?.vendor ?? getModelProvider(stripModelContextHint(normalized))
  const product = parsed ? stripModelContextHint(parsed.product) : id
  const vendorProduct = vendor ? `${vendor}/${product}` : undefined
  const effectiveRoute = route ?? parsed?.route
  // A caller that already has the catalog's row (`row.ref`, `row.route`)
  // passes its OWN directness so this stays byte-for-byte the read-side rule;
  // spawn / live set_model derive it from the effective route.
  const direct =
    directOverride ??
    (vendor !== undefined && effectiveRoute !== undefined
      ? effectiveRoute === vendor
      : !normalized.includes("@"))
  const ref =
    vendorProduct === undefined
      ? undefined
      : direct
        ? vendorProduct
        : effectiveRoute
          ? `${vendorProduct}@${effectiveRoute}`
          : normalized.includes("@")
            ? normalized
            : vendorProduct
  return { id, product, ...(vendorProduct ? { vendorProduct } : {}), ...(ref ? { ref } : {}), direct }
}

/**
 * True when `profile`'s curation admits `model` on `route`. An absent
 * curation or `mode: "all"` admits everything (today's behavior).
 */
export function profileAllowsModelId(
  profile: Pick<AuthProfile, "models">,
  model: string,
  opts?: { route?: string; direct?: boolean },
): boolean {
  const curation = profile.models
  if (!curation || curation.mode === "all") return true
  const identity = modelIdentity(model, opts?.route, opts?.direct)
  const candidates = new Set(
    [identity.id, identity.vendorProduct, identity.ref]
      .filter((value): value is string => typeof value === "string" && value.length > 0)
      .map(stripModelContextHint),
  )
  const ids = curation.ids.map(stripModelContextHint)
  if (ids.some(id => candidates.has(id))) return true
  return identity.direct && ids.includes(identity.product)
}

/** The refusal text every enforcement point shares — names the profile,
 *  the rejected model and the allowed ids. */
export function profileModelAllowlistMessage(profileId: string, model: string, ids: readonly string[]): string {
  return (
    `auth profile "${profileId}" does not allow model "${model}" ` +
    `(models.mode: "allow", allowed ids: ${ids.length > 0 ? ids.join(", ") : "none"}).`
  )
}
