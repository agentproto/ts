/**
 * Adapter-aware model id → wire normalization.
 *
 * The catalog's canonical model refs (`vendor/product[@route]`) are NOT the
 * ids every adapter accepts on its wire. A fixed-single-provider native
 * adapter (claude-code, claude-sdk, codex, …) wants the bare product id its
 * own manifest declares; a derived-from-model router (hermes, pi, opencode,
 * …) derives its endpoint FROM the vendor prefix and needs it kept. A gateway
 * `@route` suffix is a catalog-join annotation that must never leak to the
 * provider.
 *
 * This function is the ONE place the spawn/restart launch config and the live
 * `setModel` path use, so those lifecycle paths cannot drift.
 */

import {
  stripFixedNativeVendor,
  stripRouteSuffix,
} from "@agentproto/model-catalog/route-identity"
import { WIDENING_ROUTES } from "./catalog-models.js"

export interface ModelWireOptions {
  /** AIP-45 `routeSelection`: how this adapter's billing route relates to the
   *  model id. `"derived-from-model"` means the endpoint falls out of the
   *  model's own vendor prefix, so only the `@route` suffix is stripped. */
  routeSelection?: "free" | "derived-from-model"
  /** Explicit gateway route chosen at spawn time (`route.gateway`). Takes
   *  precedence over `fixedProvider` when deciding whether to strip a matching
   *  vendor prefix (e.g. a Moonshot gateway spawn bares `moonshot/…`). */
  gateway?: string
  /** The adapter manifest's fixed provider (`authDescriptor.provider`), when
   *  the adapter is a single-provider native adapter. Used to bare a matching
   *  `vendor/product` direct ref. */
  fixedProvider?: string
  /**
   * `AdapterAuthDescriptor.modelDerivedApiKey` — this adapter parses the wire
   * model id's OWN leading path segment to pick which provider key to inject
   * (`modelIdPrefixProvider`, session-spawn.ts) and its own ACP model selector
   * validates against that same literal shape. For a `derived-from-model`
   * adapter billed through a gateway/router (openrouter/requesty/huggingface),
   * that means the gateway must be a literal LEADING segment on the wire
   * (`openrouter/z-ai/glm-5.3-flash`) — the catalog's bare `vendor/product`
   * form (`z-ai/glm-5.3-flash`) 404s upstream even though the route resolves
   * fine and the money-safety/adapter-capability guards both pass it (see
   * `checkModelAdapterEligibility`'s doc: it proves the combination reachable
   * by SOME curated shape, not that the caller's literal string IS that
   * shape). opencode/mastracode/jcode/pi/mastra-agent all set this; hermes
   * does not — its `/model` command path wants the bare `vendor/product` id
   * (see `buildHermesModelMenu`'s `${bareId}@openrouter` catalog annotation,
   * stripped to bare before the wire, same as today).
   */
  modelDerivedApiKey?: boolean
}

/**
 * Normalize a catalog model id to the value the adapter's wire actually
 * expects.
 *
 * Derived-from-model adapters keep the vendor prefix and only lose the
 * explicit `@route` suffix (Hermes/OpenRouter needs `moonshotai/kimi-k2.7-code`,
 * not `kimi-k2.7-code`). Fixed native adapters collapse a direct
 * `provider/product` ref to the bare product (claude-code wants
 * `claude-sonnet-5`, not `anthropic/claude-sonnet-5`). Gateway-routed refs
 * keep their `vendor/product` because the gateway needs it.
 */
export function normalizeModelForWire(
  model: string,
  opts: ModelWireOptions,
): string {
  if (opts.routeSelection === "derived-from-model") {
    const bare = stripRouteSuffix(model)
    // Re-add the router as a literal leading segment for a model-derived-
    // API-key adapter billed through a widening gateway — see
    // `ModelWireOptions.modelDerivedApiKey`'s doc. `startsWith` guards
    // idempotency: a caller that already passed the router-prefixed shape
    // (e.g. the Configuration Lab / change-model picker, sourced from the
    // adapter's own advertised menu) is left untouched rather than
    // double-prefixed.
    if (
      opts.modelDerivedApiKey &&
      opts.gateway &&
      (WIDENING_ROUTES as readonly string[]).includes(opts.gateway) &&
      !bare.startsWith(`${opts.gateway}/`)
    ) {
      return `${opts.gateway}/${bare}`
    }
    return bare
  }
  const nativeVendor = opts.gateway ?? opts.fixedProvider
  if (nativeVendor) {
    return stripFixedNativeVendor(model, nativeVendor)
  }
  return stripRouteSuffix(model)
}
