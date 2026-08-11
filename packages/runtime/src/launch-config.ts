/**
 * Route-aware launch-config builder shared by fresh spawn
 * (`session-spawn.ts`) and restart (`session-restart-core.ts`).
 *
 * Centralizes the decisions that must stay identical across the two paths so
 * a restart cannot silently diverge from a fresh spawn:
 *   - when/how to inject a resolved gateway `base_url` into `config.options`
 *   - skills normalization against the manifest's declared option shape
 *   - stripping catalog route-identity suffixes / native vendor prefixes from
 *     the model id before it reaches the wire
 *
 * Secrets never enter this layer: `authSpec` is a fully-resolved billing-auth
 * spec whose credential is already in-memory; `baseUrl` here is a non-secret
 * endpoint URL.
 */

import { normalizeModelForWire } from "./model-wire.js"
import type { RouteSpec } from "./session-config.js"
import {
  normalizeSkillsOption,
  type DeclaredAdapterOption,
  type ResolvedAuthSpec,
} from "./spawn-defaults.js"

export interface RouteAwareLaunchConfigInput {
  /** Adapter slug — used only in error messages. */
  adapter: string
  /** Operator-facing model id (may carry `@route` suffix or native vendor prefix). */
  model?: string
  /** Resolved endpoint/gateway rail. */
  route?: RouteSpec
  /** Fully-resolved billing-auth spec (carries the gateway baseUrl when one was resolved). */
  authSpec?: ResolvedAuthSpec
  /**
   * Options BEFORE any route/base_url injection. For a fresh spawn this is
   * `spawnDefaults.options`; for a restart it is any explicit override options
   * (today restart carries none, but the shape stays forward-compatible).
   */
  options?: Record<string, boolean | number | string>
  /** Manifest-declared options — drives whether `base_url` is a valid option id. */
  declaredOptions?: readonly DeclaredAdapterOption[]
  /** Manifest-declared route selection strategy. */
  routeSelection?: "free" | "derived-from-model"
  /** Fixed provider for this adapter (e.g. `"anthropic"`), used for wire-model prefix stripping. */
  adapterProvider?: string
  /** Skills list folded into `options.skills` per the manifest's declared shape. */
  skills?: string[]
  /**
   * Prefix for error messages. `agent_start` for the spawn path, `restart`
   * for the restart path, so fail-loud messages name the caller.
   */
  prefix?: string
}

export interface RouteAwareLaunchConfig {
  /** Options ready for `AgentCliStartOptions.config.options`. */
  options?: Record<string, boolean | number | string>
  /** Model id to pass to the wire, with route suffix / native vendor prefix stripped. */
  wireModel?: string
  /** The resolved base_url that routing applied (or attempted to), for descriptor echo. */
  resolvedBaseUrl?: string
}

/**
 * Build the route-aware pieces of an agent-cli `startSession` call.
 *
 * Mirrors the logic historically inline in `session-spawn.ts` (the D1 fix):
 * a gateway-resolved `base_url` is only injected when the adapter manifest
 * actually declares a `base_url` option, OR when the resolver reported no
 * declared option vocabulary at all (pre-D1 fallback). For derived-from-model
 * adapters the resolved gateway `base_url` is skipped silently because the
 * adapter derives its endpoint from the model prefix. Native fixed-provider
 * gateway presets (e.g. codex + `route.gateway: "openai"`) have their base_url
 * dropped upstream in `resolveAuthSpec`, so they pass through this layer
 * without injection. Any other route base_url for an adapter that cannot accept
 * it fails loud rather than silently dropping the operator's billing choice or
 * crashing manifest validation on an undeclared option.
 *
 * Returns `options` only when there is at least one option to set, so callers
 * can omit the `config.options` field entirely when empty.
 */
export function buildRouteAwareLaunchConfig(
  input: RouteAwareLaunchConfigInput,
): RouteAwareLaunchConfig {
  const prefix = input.prefix ?? "agent_start"
  const baseOptions = input.options ?? {}

  const hasExplicitBaseUrlOption =
    typeof baseOptions.base_url === "string" && baseOptions.base_url.length > 0

  // A gateway PRESET's resolved base_url (`authSpec.baseUrl`) is distinct from
  // an operator-supplied CUSTOM route base_url (`route.baseUrl`). Both are
  // treated the same way here: they are only injected when the adapter manifest
  // declares a `base_url` option, or when we have no option vocabulary from the
  // resolver (pre-D1 fallback). Derived-from-model adapters skip the injection
  // entirely — they derive their endpoint from the model id's own vendor prefix,
  // so a routed base_url would either be unusable or crash manifest validation.
  // Native fixed-provider gateway presets have already had their base_url dropped
  // by `resolveAuthSpec`, so `authSpec.baseUrl` is undefined and this block is
  // skipped. Any other base_url for an adapter that cannot accept it fails loud.
  const gatewayResolvedBaseUrl = input.authSpec?.baseUrl
  const resolvedBaseUrl = gatewayResolvedBaseUrl ?? input.route?.baseUrl

  let routedOptions = baseOptions
  if (
    !hasExplicitBaseUrlOption &&
    typeof resolvedBaseUrl === "string" &&
    resolvedBaseUrl.length > 0
  ) {
    const declaresBaseUrl =
      input.declaredOptions?.some((o) => o.id === "base_url") ?? false
    // `declaredOptions === undefined` means the resolver reported no option
    // vocabulary at all — absence of information is not evidence of rejection,
    // so keep the pre-D1 behavior for that case.
    const declaredOptionsKnown = input.declaredOptions !== undefined
    if (declaresBaseUrl || !declaredOptionsKnown) {
      // Adapter accepts base_url, OR we have no manifest option vocabulary
      // to prove it doesn't — honor the resolved/custom URL.
      routedOptions = { ...baseOptions, base_url: resolvedBaseUrl }
    } else if (input.routeSelection === "derived-from-model") {
      // Adapter derives its route from the model id's own vendor prefix; the
      // resolved gateway/custom base_url is simply unusable AND unnecessary for
      // it. Drop it silently rather than crash manifest validation.
      routedOptions = baseOptions
    } else {
      // Cannot accept base_url and cannot derive route — fail loud and name the
      // gap rather than silently mis-route or crash.
      throw new Error(
        `${prefix}: adapter "${input.adapter}" cannot be routed through gateway ` +
          `"${input.route?.gateway ?? "unknown"}" — it declares no \`base_url\` option ` +
          `and does not derive its route from the model id (routeSelection ` +
          `!== "derived-from-model"), so the resolved gateway endpoint has nowhere ` +
          `to go. Declare a \`base_url\` option on the adapter manifest, or mark it ` +
          `\`routeSelection: "derived-from-model"\` if it already resolves its own ` +
          `gateway from the model prefix.`,
      )
    }
  }

  const effectiveOptions = normalizeSkillsOption(
    input.skills ?? [],
    routedOptions,
    input.declaredOptions,
  )

  // The model id delivered to the UPSTREAM wire must be BARE. A catalog `@route`
  // suffix is a catalog-join annotation — the route is carried separately via
  // `route.gateway` → base_url above, and providers reject the suffixed literal.
  // For a fixed-provider, non-derived-from-model adapter, also strip the native
  // vendor prefix so the id matches what that adapter's own selector expects.
  const wireModel = input.model
    ? normalizeModelForWire(input.model, {
        routeSelection: input.routeSelection,
        gateway: input.route?.gateway,
        fixedProvider: input.adapterProvider,
      })
    : undefined

  const out: RouteAwareLaunchConfig = {}
  if (Object.keys(effectiveOptions).length > 0) {
    out.options = effectiveOptions
  }
  if (wireModel) {
    out.wireModel = wireModel
  }
  if (resolvedBaseUrl) {
    out.resolvedBaseUrl = resolvedBaseUrl
  }
  return out
}
