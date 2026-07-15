/**
 * Route-aware model identity.
 *
 * Canonical reference syntax:
 *   vendor/product[@route]
 *
 * A model product (who built it + what product) is separate from its serving
 * route (how we reach it / how we are billed).
 *
 * Examples:
 *   openai/gpt-4o              → vendor openai, product gpt-4o, route openai (direct)
 *   openai/gpt-4o@openrouter   → same product, routed through OpenRouter
 *   openai/gpt-4o@agentik-proxy → same product, operator-configured proxy route
 *
 * Design invariants:
 *   - `vendor` is who built the model; `route` is how we reach it.
 *   - `provider/model` strings parse as vendor/product with implicit route = vendor
 *     (backward-compatible reference form).
 *   - Unscoped `xx@yy` is rejected.
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

// ── Parser ─────────────────────────────────────────────────────────────────

const SEGMENT_RE = /^[a-zA-Z0-9_.-]+$/
const REF_RE = /^([^/@]+)\/([^/@]+)(?:@([^/@]+))?$/

export interface ModelRef {
  /** The original, trimmed string. */
  raw: string
  /** Model author / builder (permanent identity). */
  vendor: string
  /** Specific model product. */
  product: string
  /** Routing target — defaults to vendor for direct vendor access. */
  route: string
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
 * Parse a model reference in `vendor/product[@route]` form.
 *
 * - `openai/gpt-4o` → `{ vendor: "openai", product: "gpt-4o", route: "openai" }`
 * - `openai/gpt-4o@openrouter` → route "openrouter"
 *
 * Rejects empty strings, unscoped `@` refs, missing segments, and segments
 * containing `/` or `@`.
 */
export function parseModelRef(raw: string): ModelRef {
  const input = raw.trim()
  if (input.length === 0) {
    throw new InvalidModelRefError(raw, "model reference is empty")
  }

  // Reject unscoped `xx@yy` before attempting the slash-based regex.
  if (input.includes("@") && !input.includes("/")) {
    throw new InvalidModelRefError(
      raw,
      "unscoped @ route is not allowed; use vendor/product[@route]"
    )
  }

  const match = REF_RE.exec(input)
  if (!match) {
    throw new InvalidModelRefError(
      raw,
      "expected vendor/product[@route] (e.g. openai/gpt-4o or openai/gpt-4o@openrouter)"
    )
  }

  const vendor = match[1]!.trim()
  const product = match[2]!.trim()
  const route = (match[3] ?? vendor).trim()

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

  return { raw: input, vendor, product, route }
}

/**
 * Format a {@link ModelRef} back to its canonical string.
 * Implicit direct routes omit the `@route` suffix.
 */
export function formatModelRef(ref: ModelRef): string {
  if (ref.route === ref.vendor) {
    return `${ref.vendor}/${ref.product}`
  }
  return `${ref.vendor}/${ref.product}@${ref.route}`
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
    custom
  )
}

function buildLlmRoute(
  ref: ModelRef,
  canonicalProductId: string,
  pricing: LLMPricing,
  transport: ModelRouteTransport,
  custom?: CustomRouteConfig
): ResolvedLlmModelRoute {
  return {
    ref,
    vendor: ref.vendor,
    product: ref.product,
    canonicalProductId,
    route: ref.route,
    transport,
    availability: custom?.availability ?? "available",
    limits: custom?.limits ?? {},
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
