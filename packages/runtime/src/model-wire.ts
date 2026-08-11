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
    return stripRouteSuffix(model)
  }
  const nativeVendor = opts.gateway ?? opts.fixedProvider
  if (nativeVendor) {
    return stripFixedNativeVendor(model, nativeVendor)
  }
  return stripRouteSuffix(model)
}
