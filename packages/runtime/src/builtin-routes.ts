/**
 * Built-in custom-route registration (PR-5).
 *
 * `resolveLlmModelRoute` (`@agentproto/model-catalog/route-identity`) resolves
 * direct/openrouter/requesty/huggingface routes from generated tables, then
 * falls through to `resolveCustomRoute(route)` — the operator-configurable
 * extension point. Until something calls `registerCustomRoute`, that map is
 * empty, so a `<vendor>/<product>@llm-endpoint` ref resolves to `undefined`
 * (no baseUrl, no pricing) and the curated `@llm-endpoint` catalog rows carry
 * no transport to spawn against.
 *
 * This module activates the one built-in custom route the runtime ships: the
 * local `llm-endpoint` Anthropic-compatible proxy. It is NOT a private/operator
 * secret — the base URL, flavor, and key-env NAME are the same public facts the
 * `llm-endpoint` gateway preset already declares (`@agentproto/provider-presets`),
 * so we derive them from that single source of truth rather than re-hardcoding
 * (and re-drifting) `localhost:18090` here.
 *
 * Called once at daemon boot (`createGateway`, `index.ts`) BEFORE any catalog
 * or route consumer runs. Additive — direct and generated router routes are
 * untouched. Operator-declared routes from `~/.agentproto/routes.json` are
 * loaded after the built-in so they can deliberately override a shipped default.
 */

import { registerCustomRoute } from "@agentproto/model-catalog/route-identity"
import { getAnthropicGatewayPreset } from "@agentproto/provider-presets"
import { loadOperatorRoutes } from "./routes-config.js"

/**
 * Register every built-in custom route. Additive — direct and the generated
 * router routes (openrouter/requesty/huggingface) are untouched.
 *
 * BREAKING (major): this function is `async` — it now also loads and applies
 * operator-declared routes from `~/.agentproto/routes.json` before resolving.
 * It was previously synchronous (`() => void`); every caller, internal or
 * external, must `await` the returned promise or operator-route overrides
 * will silently not apply.
 */
export async function registerBuiltinRoutes(): Promise<void> {
  // The local llm-endpoint Anthropic-compatible proxy. Its baseUrl/flavor/
  // key-env are owned by the gateway preset (the single source of truth for
  // these facts across adapters) — mirror them so a preset change here can't
  // silently diverge from the route the catalog resolves.
  const preset = getAnthropicGatewayPreset("llm-endpoint")
  registerCustomRoute("llm-endpoint", {
    label: preset.label,
    flavor: preset.schemaFlavor,
    baseUrl: preset.baseUrl,
    authEnv: preset.keyEnv,
  })

  // Then load operator-declared routes from ~/.agentproto/routes.json. These
  // intentionally override built-ins, so an operator can retarget a shipped
  // default (e.g. llm-endpoint) locally without patching code.
  const loaded = await loadOperatorRoutes()
  for (const error of loaded.errors) {
    console.error("[runtime] custom routes config error:", error)
  }
  for (const [id, config] of Object.entries(loaded.routes)) {
    try {
      registerCustomRoute(id, config)
    } catch (err) {
      console.error(
        `[runtime] failed to register custom route "${id}":`,
        err,
      )
    }
  }
  const loadedIds = Object.keys(loaded.routes)
  if (loadedIds.length > 0) {
    // eslint-disable-next-line no-console
    console.log(`[runtime] loaded custom routes: ${loadedIds.join(", ")}`)
  }
}
