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

import type { SessionConfigOption } from "@agentproto/acp/client"

import {
  stripFixedNativeVendor,
  stripRouteSuffix,
} from "@agentproto/model-catalog/route-identity"
import { WIDENING_ROUTES } from "./catalog-models.js"

/** One model value the LIVE agent session advertises as acceptable. */
export interface AdvertisedModelValue {
  /** The value to hand the agent verbatim (`configId:"model"`). */
  value: string
  /** The agent's own human label for it. */
  name: string
  /** The agent's own description, when it gave one. */
  description?: string
}

/**
 * The model values a LIVE agent session advertises, read off the ACP
 * `configOptions` snapshot the wrapper returned at connect time
 * (`newSession`/`loadSession`). The agent's OWN list is the only authority on
 * what it will accept on `session/set_config_option(configId:"model")` — the
 * catalog's ids are a different vocabulary, and offering a catalog id the
 * agent never advertised is exactly what makes a live switch fail with
 * "Invalid value for config option model: …".
 *
 * Empty when the agent advertises no `model` option (older wrappers, arms
 * without a config surface) — never inferred, never guessed.
 */
export function advertisedModelValues(
  options: readonly SessionConfigOption[] | undefined,
): AdvertisedModelValue[] {
  if (!options) return []
  const option = options.find(o => o.id === "model" && o.type === "select")
  if (!option) return []
  const select = option as Extract<SessionConfigOption, { type: "select" }>
  const raw = select.options as unknown[]
  if (!Array.isArray(raw)) return []
  const values: AdvertisedModelValue[] = []
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue
    const maybeGroup = entry as { group?: unknown; options?: unknown }
    if (Array.isArray(maybeGroup.options)) {
      // A grouped list: the group's own name describes every value under it.
      const groupName = typeof maybeGroup.group === "string" ? maybeGroup.group : undefined
      for (const child of maybeGroup.options) {
        const value = valueOf(child)
        if (!value) continue
        const description = value.description ?? groupName
        values.push({
          value: value.value,
          name: value.name,
          ...(description ? { description } : {}),
        })
      }
      continue
    }
    const value = valueOf(entry)
    if (!value) continue
    values.push(value)
  }
  return values
}

/** Normalize one advertised option entry to `{value, name, description?}`. */
function valueOf(entry: unknown): AdvertisedModelValue | undefined {
  if (!entry || typeof entry !== "object") return undefined
  const rec = entry as { value?: unknown; name?: unknown; description?: unknown }
  if (typeof rec.value !== "string" || rec.value.length === 0) return undefined
  const name = typeof rec.name === "string" && rec.name.length > 0 ? rec.name : rec.value
  const description =
    typeof rec.description === "string" && rec.description.length > 0 ? rec.description : undefined
  return { value: rec.value, name, ...(description ? { description } : {}) }
}

/**
 * Resolve a requested model id to the value the live agent will actually
 * accept, given the values it advertises.
 *
 * Exact match wins (the agent's own spelling is the wire truth). Failing
 * that, a case-insensitive match. Failing THAT, a unique prefix match — the
 * catalog publishes an UNDATED id (`claude-sonnet-5-5`) where the agent
 * advertises a dated one (`claude-sonnet-5-5-20260101`), and refusing the
 * switch over that suffix is a needless dead end. Anything less certain
 * (several prefix matches, no match at all) resolves `undefined`, and the
 * caller keeps its own normalization — a genuine "this agent does not offer
 * that model" stays visible as the agent's own rejection.
 */
export function resolveAdvertisedModelValue(
  requested: string,
  advertised: readonly AdvertisedModelValue[],
): string | undefined {
  if (advertised.length === 0) return undefined
  const exact = advertised.find(a => a.value === requested)
  if (exact) return exact.value
  const lower = requested.toLowerCase()
  const insensitive = advertised.find(a => a.value.toLowerCase() === lower)
  if (insensitive) return insensitive.value
  const prefixed = advertised.filter(a => a.value.toLowerCase().startsWith(lower))
  if (prefixed.length === 1) return prefixed[0].value
  const suffixed = advertised.filter(a => lower.startsWith(a.value.toLowerCase()))
  if (suffixed.length === 1) return suffixed[0].value
  return undefined
}

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
