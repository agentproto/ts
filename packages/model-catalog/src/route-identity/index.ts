/**
 * Route-aware model identity.
 *
 * Canonical reference syntax:
 *   [route:]vendor/product[:pin][@route]
 *
 * A model product (who built it + what product) is separate from its serving
 * route (how we reach it / how we are billed) and from an optional `:pin` —
 * an OpenRouter routing variant or an inference-provider selector.
 *
 * Three axes:
 *
 * | Axis               | Question it answers          | Example value            |
 * |---------------------|------------------------------|---------------------------|
 * | `vendor`            | who built the model          | `openai`, `anthropic`     |
 * | `route`             | how we reach it / are billed | `openrouter`, `huggingface`, `openai` (direct) |
 * | `inferenceProvider` / `variant` | who runs the GPUs behind a router, or which routing mode | `cerebras`, `groq` (provider); `free`, `nitro` (variant) |
 *
 * Examples:
 *   openai/gpt-4o                    → vendor openai, product gpt-4o, route openai (direct)
 *   openai/gpt-4o@openrouter         → same product, routed through OpenRouter
 *   openai/gpt-4o@agentik-proxy      → same product, operator-configured proxy route
 *   deepseek/deepseek-chat:free@openrouter → OpenRouter, variant "free"
 *   openrouter:deepseek/deepseek-chat:free → legacy PREFIX form, same result
 *   meta-llama/Llama-3.1-8B:cerebras@huggingface → HuggingFace, inference-provider pin "cerebras"
 *
 * `:pin` classification (per the resolved route):
 *   - `openrouter` (or no explicit route) + pin ∈ {free, nitro, floor, online,
 *     exacto} → `variant` (a routing mode, not a provider).
 *   - anything else → `inferenceProvider` (HF inference provider / OpenRouter
 *     provider pin).
 *
 * Design invariants:
 *   - `vendor` is who built the model; `route` is how we reach it.
 *   - `provider/model` strings parse as vendor/product with implicit route = vendor
 *     (backward-compatible reference form).
 *   - Unscoped `xx@yy` is rejected; bare ids without a slash are rejected
 *     (lenient handling belongs in consumers — see `tryParseModelRef`).
 *   - The legacy `route:` PREFIX (colon before the first `/`, prefix must be a
 *     known route name) parses; an explicit `@route` suffix wins on conflict.
 *     `formatModelRef` always emits the canonical suffix form.
 *   - Route metadata (pricing, limits, transport, availability) is separate from
 *     product metadata and computed at resolution time.
 *   - The abstraction is generic across model kinds; only LLM has a concrete
 *     resolver today.
 */

import type { LLMPricing } from "../llm/catalog.js"
import {
  resolvePricing,
  resolveAlias,
  DEFAULT_PRICING,
} from "../llm/catalog.js"
import { OPENROUTER_ROUTES } from "../llm/openrouter-routes.generated.js"
import { REQUESTY_ROUTES } from "../llm/requesty-routes.generated.js"
import {
  HUGGINGFACE_ROUTES,
  type HuggingFaceRouteProvider,
} from "../llm/huggingface-routes.generated.js"
import { CatalogProviderSchema } from "../schema/base.js"

// ── Parser ─────────────────────────────────────────────────────────────────

const SEGMENT_RE = /^[a-zA-Z0-9_.-]+$/

/**
 * OpenRouter variant suffixes — a CLOSED list. A `:pin` matching one of
 * these on the OpenRouter route (or on a route-less/implicit-route id) is a
 * routing *variant*, never an inference-provider pin.
 * @see https://openrouter.ai/docs/features/provider-routing
 */
export const OPENROUTER_VARIANTS = [
  "free",
  "nitro",
  "floor",
  "online",
  "exacto",
] as const
export type OpenRouterVariant = (typeof OPENROUTER_VARIANTS)[number]

const OPENROUTER_VARIANT_SET: ReadonlySet<string> = new Set(OPENROUTER_VARIANTS)

/**
 * Route names recognised as a LEGACY `route:` PREFIX (colon before the first
 * `/`). Derived from `CatalogProviderSchema` — the same enum that gates
 * `selectRouter` below — so a prefix is legacy sugar for a route the catalog
 * already knows, never an ambiguous guess.
 */
const KNOWN_ROUTE_PREFIXES: ReadonlySet<string> = new Set<string>(
  CatalogProviderSchema.options
)

export interface ModelRef {
  /** The original, trimmed string. */
  raw: string
  /** Model author / builder (permanent identity). */
  vendor: string
  /** Specific model product. */
  product: string
  /** Routing target — defaults to vendor for direct vendor access. */
  route: string
  /**
   * Explicit `:pin` classified as an inference-provider selector (HF
   * inference provider, or an OpenRouter provider pin outside the closed
   * variant list) rather than a routing variant.
   */
  inferenceProvider?: string
  /** OpenRouter routing variant (`free`, `nitro`, `floor`, `online`, `exacto`) — a closed list, never a provider. */
  variant?: string
}

export class InvalidModelRefError extends Error {
  readonly name = "InvalidModelRefError"
  constructor(
    public readonly raw: string,
    message: string
  ) {
    super(`Invalid model reference "${raw}": ${message}`)
  }
}

/**
 * Classify a `:pin` given the route it resolves against (the EXPLICIT route
 * only — from `@route` or the legacy prefix — never the vendor-defaulted
 * one, so a bare `vendor/product:free` is still OpenRouter-eligible).
 *
 * Per-route rules:
 *   - `openrouter`, or no explicit route → a closed-list variant becomes
 *     `variant`; anything else is an inference-provider pin.
 *   - every other route (`huggingface`, direct vendors, custom proxies,
 *     unknown routes) → always an inference-provider pin.
 */
function classifyPin(
  pin: string,
  explicitRoute: string | undefined
): Pick<ModelRef, "inferenceProvider" | "variant"> {
  const openRouterEligible = explicitRoute === "openrouter" || explicitRoute === undefined
  if (openRouterEligible && OPENROUTER_VARIANT_SET.has(pin)) {
    return { variant: pin }
  }
  return { inferenceProvider: pin }
}

/**
 * Parse a model reference in `[route:]vendor/product[:pin][@route]` form.
 *
 * - `openai/gpt-4o` → `{ vendor: "openai", product: "gpt-4o", route: "openai" }`
 * - `openai/gpt-4o@openrouter` → route "openrouter"
 * - `deepseek/deepseek-chat:free@openrouter` → route "openrouter", variant "free"
 * - `meta-llama/Llama-3.1-8B:cerebras@huggingface` → route "huggingface", inferenceProvider "cerebras"
 * - `openrouter:anthropic/claude-sonnet-4.5` → legacy prefix, route "openrouter"
 *
 * Rejects empty strings, unscoped `@` refs, bare ids without a slash, missing
 * segments, and segments containing `/` or `@`. `@route` wins over the
 * legacy prefix when both are present.
 */
export function parseModelRef(raw: string): ModelRef {
  const input = raw.trim()
  if (input.length === 0) {
    throw new InvalidModelRefError(raw, "model reference is empty")
  }

  // 1. Peel the explicit `@route` suffix (highest-priority route source).
  let body = input
  let atRoute: string | undefined
  const atIdx = input.indexOf("@")
  if (atIdx !== -1) {
    body = input.slice(0, atIdx)
    atRoute = input.slice(atIdx + 1)
  }

  // Reject unscoped `xx@yy` — no slash anywhere before the `@`.
  if (atIdx !== -1 && !body.includes("/")) {
    throw new InvalidModelRefError(
      raw,
      "unscoped @ route is not allowed; use vendor/product[@route]"
    )
  }

  // 2. Peel the legacy `route:` PREFIX from the body — a colon before the
  // first `/` whose prefix is a known route name.
  let prefixRoute: string | undefined
  let remainder = body
  const bodySlashIdx = body.indexOf("/")
  if (bodySlashIdx !== -1) {
    const bodyColonIdx = body.indexOf(":")
    if (bodyColonIdx !== -1 && bodyColonIdx < bodySlashIdx) {
      const candidate = body.slice(0, bodyColonIdx)
      if (KNOWN_ROUTE_PREFIXES.has(candidate)) {
        prefixRoute = candidate
        remainder = body.slice(bodyColonIdx + 1)
      }
    }
  }

  // 3. Split the remainder into `vendor/product[:pin]`.
  const remSlashIdx = remainder.indexOf("/")
  if (remSlashIdx === -1) {
    throw new InvalidModelRefError(
      raw,
      "expected vendor/product[:pin][@route] (e.g. openai/gpt-4o or openai/gpt-4o@openrouter)"
    )
  }
  const vendor = remainder.slice(0, remSlashIdx).trim()
  const afterVendor = remainder.slice(remSlashIdx + 1)

  let product = afterVendor
  let pin: string | undefined
  const pinColonIdx = afterVendor.indexOf(":")
  if (pinColonIdx !== -1) {
    product = afterVendor.slice(0, pinColonIdx)
    pin = afterVendor.slice(pinColonIdx + 1)
  }
  product = product.trim()

  // 4. `@route` wins over the legacy prefix; both fall back to `vendor`.
  const explicitRoute = atRoute ?? prefixRoute
  const route = (explicitRoute ?? vendor).trim()

  for (const [label, value] of [
    ["vendor", vendor],
    ["product", product],
    ["route", route],
  ] as const) {
    if (value.length === 0) {
      throw new InvalidModelRefError(raw, `${label} segment is empty`)
    }
    if (!SEGMENT_RE.test(value)) {
      throw new InvalidModelRefError(
        raw,
        `${label} "${value}" contains invalid characters (no '/' or '@')`
      )
    }
  }
  if (pin !== undefined) {
    if (pin.length === 0) {
      throw new InvalidModelRefError(raw, "pin segment is empty")
    }
    if (!SEGMENT_RE.test(pin)) {
      throw new InvalidModelRefError(
        raw,
        `pin "${pin}" contains invalid characters (no '/' or '@')`
      )
    }
  }

  const classified = pin !== undefined ? classifyPin(pin, explicitRoute) : {}

  return { raw: input, vendor, product, route, ...classified }
}

/**
 * {@link parseModelRef}, but never throws — returns `undefined` for any
 * input the strict grammar rejects (bare ids, malformed refs, …). Lenient
 * handling of non-canonical ids belongs in callers; this just makes the
 * strict parser safe to probe.
 */
export function tryParseModelRef(raw: string): ModelRef | undefined {
  try {
    return parseModelRef(raw)
  } catch {
    return undefined
  }
}

/**
 * Format a {@link ModelRef} back to its canonical string
 * `vendor/product[:pin][@route]`. Implicit direct routes omit the `@route`
 * suffix. Always emits the canonical suffix form — never the legacy
 * `route:` prefix — so `formatModelRef(parseModelRef(x))` is stable
 * (idempotent under re-parse). Prefers `variant` over `inferenceProvider`
 * when (implausibly) both are set, since parse only ever produces one.
 */
export function formatModelRef(ref: ModelRef): string {
  let out = `${ref.vendor}/${ref.product}`
  const pin = ref.variant ?? ref.inferenceProvider
  if (pin !== undefined) out += `:${pin}`
  if (ref.route !== ref.vendor) out += `@${ref.route}`
  return out
}

/**
 * Strip a route-identity `@route` SUFFIX from a model id, returning the bare
 * id that an UPSTREAM (the provider/gateway, via `ANTHROPIC_MODEL` or the wire
 * `model`) actually understands. The `@route` suffix is a catalog-join
 * annotation used to pin which serving route a picked model uses — the gateway
 * itself never sees it (OpenRouter/Requesty/the llm-endpoint proxy don't
 * recognise `z-ai/glm-5.2@openrouter`, only `z-ai/glm-5.2`). At spawn the route
 * is already carried separately (`route.gateway` → base_url), so the suffix is
 * redundant metadata that must not leak to the wire.
 *
 * - `z-ai/glm-5.2@openrouter`            → `z-ai/glm-5.2`
 * - `deepseek/deepseek-chat:free@openrouter` → `deepseek/deepseek-chat:free` (variant kept)
 * - `glm-5.2@llm-endpoint`               → `glm-5.2` (routeless proxy alias)
 * - `claude-opus-4-8`                    → `claude-opus-4-8` (no route, unchanged)
 * - `openai/gpt-4o`                      → `openai/gpt-4o` (direct route, unchanged)
 *
 * Prefers the strict parser so an id is only altered when the trailing token is
 * a genuine explicit route (`route !== vendor`); the pin (`:variant` /
 * `:inferenceProvider`) is preserved because gateways accept it. Falls back to
 * removing only a trailing `@…` for ids the strict grammar rejects (e.g. the
 * vendor-less `glm-5.2@llm-endpoint`): the SEGMENT grammar forbids `@`
 * anywhere but the route separator, so the last `@` can only be that.
 */
export function stripRouteSuffix(raw: string): string {
  const ref = tryParseModelRef(raw)
  if (ref) {
    // Re-emit without the route suffix. `formatModelRef` omits `@route` exactly
    // when `route === vendor`, so forcing that yields `vendor/product[:pin]`.
    return formatModelRef({ ...ref, route: ref.vendor })
  }
  const atIdx = raw.lastIndexOf("@")
  return atIdx === -1 ? raw : raw.slice(0, atIdx)
}

/**
 * Reduce a DIRECT-anthropic catalog ref to the BARE product id the native
 * Anthropic wire expects (the `claude` ACP wrapper's `session/set_config_option`
 * model selector, and claude-sdk's `env.ANTHROPIC_MODEL`) — both resolve only
 * bare Anthropic ids (`claude-sonnet-4-5`), never the catalog's canonical
 * `anthropic/claude-sonnet-4-5` route form. {@link stripRouteSuffix} only peels
 * the `@route` SUFFIX and deliberately keeps `vendor/product`, so a
 * direct-anthropic ref survives it prefixed and the wrapper mis-resolves it.
 *
 * ONLY a `anthropic/<product>` ref in DIRECT form (route === vendor, i.e. no
 * gateway `@route`) collapses to `<product>`. Everything else falls through to
 * {@link stripRouteSuffix} untouched:
 *   - a GATEWAY-routed anthropic ref (`anthropic/claude-x@openrouter`) keeps its
 *     `vendor/product` because the gateway needs it,
 *   - other vendors (`z-ai/glm-5.2@openrouter`, `moonshot/kimi-k2.7-code@llm-endpoint`)
 *     keep `vendor/product` — those same claude-code/claude-sdk adapters route
 *     them through `base_url`, where the gateway rejects a bare product,
 *   - already-bare ids (`claude-sonnet-5`) are unchanged.
 *
 * Callers MUST gate this on the adapter being Anthropic-NATIVE (claude-code /
 * claude-sdk, `provider: "anthropic"`); a `derived-from-model` adapter (hermes,
 * opencode, …) derives its route FROM the vendor prefix and needs it kept.
 *
 * - `anthropic/claude-sonnet-4-5`            → `claude-sonnet-4-5`
 * - `anthropic/claude-sonnet-4-5@openrouter` → `anthropic/claude-sonnet-4-5`
 * - `z-ai/glm-5.2@openrouter`                → `z-ai/glm-5.2`
 * - `claude-sonnet-5`                        → `claude-sonnet-5`
 */
export function stripAnthropicNativeVendor(raw: string): string {
  return stripFixedNativeVendor(raw, "anthropic")
}

/**
 * Generalized form of {@link stripAnthropicNativeVendor} — reduce a
 * DIRECT-`vendor` catalog ref to the BARE product id a fixed-single-provider
 * adapter's own wire expects, for ANY vendor, not just Anthropic. Every
 * adapter whose manifest declares a FIXED `provider` and takes bare model ids
 * on its native route (claude-code/claude-sdk → anthropic, codex → openai,
 * gemini → google, …) hits this same class of bug: the catalog's canonical
 * `vendor/product` form survives onto the wire and the adapter's own
 * `models.allowed` enum — which declares bare ids — rejects it
 * (`option_enum_violation`).
 *
 * ONLY a `<vendor>/<product>` ref in DIRECT form (route === vendor, i.e. no
 * gateway `@route`) AND matching the given `vendor` collapses to `<product>`.
 * Everything else falls through to {@link stripRouteSuffix} untouched:
 *   - a GATEWAY-routed ref (`openai/gpt-5@openrouter`) keeps its
 *     `vendor/product` because the gateway needs it,
 *   - a ref for a DIFFERENT vendor (`z-ai/glm-5.2` handed to an
 *     `openai`-fixed adapter) keeps `vendor/product` — stripping would
 *     invent a wrong bare id for a model this adapter doesn't natively serve,
 *   - already-bare ids (`gpt-5`) are unchanged.
 *
 * Callers MUST gate this on the adapter being a FIXED-single-provider,
 * non-derived-from-model adapter (`routeSelection !== "derived-from-model"`
 * AND a fixed `provider`); a `derived-from-model` adapter (hermes, pi,
 * opencode, …) derives its route FROM the vendor prefix and needs it kept.
 *
 * - `openai/gpt-5`               (vendor "openai") → `gpt-5`
 * - `openai/gpt-5@openrouter`    (vendor "openai") → `openai/gpt-5`
 * - `z-ai/glm-5.2`               (vendor "openai") → `z-ai/glm-5.2` (mismatch, unchanged)
 * - `gpt-5`                      (vendor "openai") → `gpt-5` (already bare)
 */
export function stripFixedNativeVendor(raw: string, vendor: string): string {
  const ref = tryParseModelRef(raw)
  if (ref && ref.vendor === vendor && ref.route === ref.vendor) {
    return ref.product
  }
  return stripRouteSuffix(raw)
}

/** True when `raw` matches the `vendor/product[@route]` shape. */
export function isModelRefString(raw: string): boolean {
  try {
    parseModelRef(raw)
    return true
  } catch {
    return false
  }
}

// ── Product vs route metadata ──────────────────────────────────────────────

export interface ModelRouteLimits {
  contextWindow?: number
  maxInputTokens?: number
  maxOutputTokens?: number
}

export type ModelRouteAvailability = "available" | "preview" | "unavailable"

export interface ModelRouteTransport {
  /** API/schema flavor: e.g. "openai", "anthropic", "openrouter", "custom". */
  flavor: string
  /** Optional explicit base URL for the route. */
  baseUrl?: string
}

/** Product metadata — independent of the serving route. */
export interface ModelProductMeta {
  vendor: string
  product: string
  /** Canonical product id after alias resolution. */
  canonicalProductId: string
}

/** Route metadata — pricing, limits, transport, availability. */
export interface ModelRouteMeta<TPricing = unknown> {
  route: string
  transport: ModelRouteTransport
  availability: ModelRouteAvailability
  limits: ModelRouteLimits
  pricing: TPricing
}

/** Fully resolved model route: product identity + route metadata. */
export interface ResolvedModelRoute<TPricing = unknown>
  extends ModelProductMeta,
    ModelRouteMeta<TPricing> {
  /** The parsed reference. */
  ref: ModelRef
}

export type ResolvedLlmModelRoute = ResolvedModelRoute<LLMPricing>

// ── Custom route config ────────────────────────────────────────────────────

/**
 * Operator-configurable custom route.
 *
 * No credential values live here — only the *name* of an env var (`authEnv`)
 * so adapters can resolve secrets at runtime. `agentik-proxy` is registered
 * through this shape; it is never hardcoded in the catalog. No private
 * models, hosts, or prices are committed.
 */
export interface CustomRouteConfig {
  label?: string
  /** API/schema flavor the route speaks. */
  flavor?: string
  /** Base URL the adapter should hit. */
  baseUrl?: string
  /** Name of the env var holding the API key/secret (not the value). */
  authEnv?: string
  availability?: ModelRouteAvailability
  limits?: ModelRouteLimits
  /** Route-level pricing override. Unset fields fall back to product pricing. */
  pricing?: Partial<LLMPricing>
}

const customRoutes = new Map<string, CustomRouteConfig>()

export function registerCustomRoute(
  id: string,
  config: CustomRouteConfig
): void {
  customRoutes.set(id, config)
}

export function resolveCustomRoute(id: string): CustomRouteConfig | undefined {
  return customRoutes.get(id)
}

/** Test helper: clear all registered custom routes. */
export function clearCustomRoutes(): void {
  customRoutes.clear()
}

// ── LLM route resolution ───────────────────────────────────────────────────

/**
 * Resolve a model reference to an LLM route, distinguishing direct vendor
 * access from explicit router/proxy routes.
 *
 *   openai/gpt-4o            → direct OpenAI pricing / transport
 *   openai/gpt-4o@openrouter → OpenRouter route pricing / transport
 *   openai/gpt-4o@requesty   → Requesty route pricing / transport
 *   meta-llama/Llama-3.1-8B:cerebras@huggingface → HuggingFace, pinned to the "cerebras" inference provider
 *   openai/gpt-4o@agentik-proxy → custom route config (if registered)
 *
 * Bare legacy ids (e.g. `gpt-4o`, `claude-sonnet-4-5`) are also accepted and
 * resolved through the legacy pricing catalog, with the route inferred from
 * the catalog entry's provider/vendor.
 *
 * Returns `undefined` when the product or route is unknown.
 */
export function resolveLlmModelRoute(
  input: string | ModelRef
): ResolvedLlmModelRoute | undefined {
  const ref =
    typeof input === "string"
      ? tryParseOrLegacy(input)
      : { ref: input, legacy: false }

  if (!ref) return undefined

  const { ref: modelRef, legacy } = ref
  const directPricing = resolvePricing(modelRef.product)
  const canonicalProductId = resolveAlias(modelRef.product)

  // ── Direct vendor route ─────────────────────────────────────────────────
  if (modelRef.route === modelRef.vendor) {
    if (!directPricing) return undefined
    return buildLlmRoute(modelRef, canonicalProductId, directPricing, {
      flavor: modelRef.vendor,
    })
  }

  // ── OpenRouter route ────────────────────────────────────────────────────
  if (modelRef.route === "openrouter") {
    const key = `${modelRef.vendor}/${modelRef.product}`
    const pricing = OPENROUTER_ROUTES[key]
    if (!pricing) return undefined
    return buildLlmRoute(modelRef, canonicalProductId, pricing, {
      flavor: "openrouter",
    })
  }

  // ── Requesty route ──────────────────────────────────────────────────────
  // Same shape as the OpenRouter branch: the router's own price table is keyed
  // by bare vendor/product, and the route lives in the ref rather than the key,
  // so `openai/gpt-4.1` (direct) and `openai/gpt-4.1@requesty` price
  // independently. REQUESTY_ROUTES is deliberately NOT spread into
  // LLM_PRICING_CATALOG — that map is the legacy bare-id path, and spreading a
  // second router into it would repoint direct-vendor ids at router pricing.
  if (modelRef.route === "requesty") {
    const key = `${modelRef.vendor}/${modelRef.product}`
    const pricing = REQUESTY_ROUTES[key]
    if (!pricing) return undefined
    return buildLlmRoute(modelRef, canonicalProductId, pricing, {
      flavor: "requesty",
    })
  }

  // ── HuggingFace route ────────────────────────────────────────────────────
  // Keyed by bare vendor/product (HF wire id), same shape as the OpenRouter/
  // Requesty branches above. Pricing comes from the pinned provider when
  // `inferenceProvider` selects one, else the cheapest live provider (min
  // input+output per-1M). Limits come from the pinned provider's context
  // length, or the max across live providers when no pin narrows the choice.
  if (modelRef.route === "huggingface") {
    const key = `${modelRef.vendor}/${modelRef.product}`
    const hfRoute = HUGGINGFACE_ROUTES[key]
    if (!hfRoute || hfRoute.providers.length === 0) return undefined

    const pinnedProvider = modelRef.inferenceProvider
      ? hfRoute.providers.find((p) => p.provider === modelRef.inferenceProvider)
      : undefined
    if (modelRef.inferenceProvider !== undefined && !pinnedProvider) return undefined

    const priced = hfRoute.providers.filter(isPricedHuggingFaceProvider)
    const cheapest = priced.reduce<(typeof priced)[number] | undefined>((best, p) => {
      if (!best) return p
      return p.inputPer1M + p.outputPer1M < best.inputPer1M + best.outputPer1M ? p : best
    }, undefined)
    const selected = pinnedProvider ?? cheapest

    const pricing: LLMPricing = {
      inputPer1M: selected?.inputPer1M ?? DEFAULT_PRICING.inputPer1M,
      outputPer1M: selected?.outputPer1M ?? DEFAULT_PRICING.outputPer1M,
      vendor: modelRef.vendor,
      provider: "huggingface",
    }

    const contextWindow = pinnedProvider
      ? pinnedProvider.contextLength
      : hfRoute.providers.reduce<number | undefined>((max, p) => {
          if (p.contextLength === undefined) return max
          return max === undefined ? p.contextLength : Math.max(max, p.contextLength)
        }, undefined)

    return buildLlmRoute(
      modelRef,
      canonicalProductId,
      pricing,
      { flavor: "openai", baseUrl: "https://router.huggingface.co/v1" },
      { limits: contextWindow !== undefined ? { contextWindow } : {} }
    )
  }

  // ── Custom route (e.g. agentik-proxy) ───────────────────────────────────
  const custom = resolveCustomRoute(modelRef.route)
  if (!custom) return undefined

  const basePricing = directPricing ?? DEFAULT_PRICING
  const pricing: LLMPricing = {
    ...basePricing,
    ...custom.pricing,
    vendor: custom.pricing?.vendor ?? basePricing.vendor,
  }

  return buildLlmRoute(
    modelRef,
    canonicalProductId,
    pricing,
    {
      flavor: custom.flavor ?? "custom",
      baseUrl: custom.baseUrl,
    },
    { availability: custom.availability, limits: custom.limits }
  )
}

/** The bare `vendor/product` keys a router's generated route table carries.
 *  Unknown routers (or non-router providers) yield an empty list — the
 *  three branches are otherwise identical, so a new router only needs a
 *  case here plus a branch in `resolveLlmModelRoute`. */
function routerRouteKeys(router: string): string[] {
  switch (router) {
    case "openrouter":
      return Object.keys(OPENROUTER_ROUTES)
    case "requesty":
      return Object.keys(REQUESTY_ROUTES)
    case "huggingface":
      return Object.keys(HUGGINGFACE_ROUTES)
    default:
      return []
  }
}

/**
 * Every LLM route a router serves, resolved through the same
 * `resolveLlmModelRoute` path used at spawn/billing time — enumeration and
 * resolution can never disagree. Ids carry the explicit `@route` suffix
 * (`vendor/product@router`), exactly what a caller passes to `agent_start`.
 * A HuggingFace key with zero live providers resolves to `undefined` and is
 * skipped, same as at resolution time. `[]` for a provider that isn't a
 * known router.
 *
 * Some generated table keys don't round-trip through the canonical
 * `vendor/product[@route]` grammar — Requesty's own key format packs a
 * region into the product with a second `@` (`azure/gpt-4.1@eastus2`) or
 * nests an upstream provider ahead of vendor/product
 * (`deepinfra/meta-llama/Llama-3.3-70B-Instruct`), and both collide with
 * `parseModelRef`'s single-`@`, single-`/`-per-segment rules. Those keys are
 * unreachable from a plain model id today regardless of enumeration — a
 * caller can't spawn what it can't spell — so `parseModelRef` throwing here
 * is skipped rather than propagated, the same way `tryParseModelRef` treats
 * any other unparseable ref.
 */
export function listRouterLlmRoutes(router: string): ResolvedLlmModelRoute[] {
  const routes: ResolvedLlmModelRoute[] = []
  for (const key of routerRouteKeys(router)) {
    let resolved: ResolvedLlmModelRoute | undefined
    try {
      resolved = resolveLlmModelRoute(`${key}@${router}`)
    } catch {
      continue
    }
    if (resolved) routes.push(resolved)
  }
  return routes
}

/** Narrows a HuggingFace provider entry to one that carries both prices. */
function isPricedHuggingFaceProvider(
  p: HuggingFaceRouteProvider
): p is HuggingFaceRouteProvider & { inputPer1M: number; outputPer1M: number } {
  return p.inputPer1M !== undefined && p.outputPer1M !== undefined
}

function buildLlmRoute(
  ref: ModelRef,
  canonicalProductId: string,
  pricing: LLMPricing,
  transport: ModelRouteTransport,
  opts?: { availability?: ModelRouteAvailability; limits?: ModelRouteLimits }
): ResolvedLlmModelRoute {
  return {
    ref,
    vendor: ref.vendor,
    product: ref.product,
    canonicalProductId,
    route: ref.route,
    transport,
    availability: opts?.availability ?? "available",
    limits: opts?.limits ?? {},
    pricing,
  }
}

interface ParseResult {
  ref: ModelRef
  legacy: boolean
}

/**
 * Parse a canonical ref, or interpret a bare legacy id as a product-only ref
 * when it resolves through the legacy catalog.
 */
function tryParseOrLegacy(raw: string): ParseResult | undefined {
  if (raw.includes("/")) {
    return { ref: parseModelRef(raw), legacy: false }
  }
  const pricing = resolvePricing(raw)
  if (!pricing) return undefined
  const vendor = pricing.vendor ?? pricing.provider ?? "unknown"
  const route = pricing.provider ?? vendor
  return {
    ref: { raw, vendor, product: raw, route },
    legacy: true,
  }
}

// ── Diagnostics ────────────────────────────────────────────────────────────

export interface ModelRefDiagnostic {
  ref: ModelRef
  /** True if this string is a legacy bare id rather than vendor/product. */
  legacyBareId: boolean
  /** True if a direct vendor route exists for the product. */
  directAvailable: boolean
  /** True if an OpenRouter route exists for vendor/product. */
  openRouterAvailable: boolean
  /** True if a custom route is registered for the route segment. */
  customRouteAvailable: boolean
  /** Human-readable note when ambiguity or a deprecation applies. */
  note?: string
}

/**
 * Inspect a model reference and report what routes are available for it.
 *
 * Useful for CLI/UI warnings when a user types `openai/gpt-4o` and an
 * explicit `@openrouter` form also exists: the direct form is chosen, but
 * the note explains how to request the OpenRouter route explicitly.
 */
export function diagnoseModelRef(
  input: string | ModelRef
): ModelRefDiagnostic | undefined {
  const parsed =
    typeof input === "string" ? tryParseOrLegacy(input) : { ref: input, legacy: false }
  if (!parsed) return undefined

  const { ref, legacy } = parsed
  const directPricing = resolvePricing(ref.product)
  const openRouterKey = `${ref.vendor}/${ref.product}`
  const openRouterPricing = OPENROUTER_ROUTES[openRouterKey]
  const custom = resolveCustomRoute(ref.route)

  const directAvailable = !!directPricing
  const openRouterAvailable = !!openRouterPricing
  const customRouteAvailable = !!custom

  let note: string | undefined
  if (legacy) {
    note = `Bare product id "${ref.product}" is a legacy form; prefer ${ref.vendor}/${ref.product}.`
  } else if (ref.route === ref.vendor && openRouterAvailable) {
    note = `Direct vendor route selected. Use ${ref.vendor}/${ref.product}@openrouter for the OpenRouter route.`
  }

  return {
    ref,
    legacyBareId: legacy,
    directAvailable,
    openRouterAvailable,
    customRouteAvailable,
    note,
  }
}
