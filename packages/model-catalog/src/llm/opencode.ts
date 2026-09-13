/**
 * OpenCode's two hosted endpoints — the small hand-written surface over their
 * generated route tables.
 *
 * Deliberately its OWN module rather than an addition to `catalog.ts`: that
 * file owns `LLM_PRICING_CATALOG`, and the one invariant these tables have is
 * that they are NEVER spread into it (a bare `claude-sonnet-5` must keep
 * meaning direct Anthropic, not a Zen-priced route — see the OpenCode branch
 * in `route-identity/index.ts`). Keeping the import out of `catalog.ts`
 * keeps that temptation out of reach.
 */

import {
  OPENCODE_GO_ANTHROPIC_MODELS,
  OPENCODE_GO_ROUTES,
} from "./opencode-go-routes.generated.js"
import {
  OPENCODE_ZEN_ANTHROPIC_MODELS,
  OPENCODE_ZEN_ROUTES,
} from "./opencode-zen-routes.generated.js"

/**
 * The two OpenCode hosted endpoints, by catalog provider id.
 *   - `"opencode"`    — OpenCode Zen, pay-as-you-go (`.../zen/v1`).
 *   - `"opencode-go"` — OpenCode Go, the flat subscription (`.../zen/go/v1`).
 */
export type OpencodeEndpoint = "opencode" | "opencode-go"

/**
 * Every model ref an OpenCode endpoint serves, in the `<provider>/<bare-id>`
 * form the route tables are keyed by — which is also opencode's own config
 * spelling and what a caller passes to `agent_start`.
 */
export function listOpencodeModelRefs(endpoint: OpencodeEndpoint): string[] {
  const routes = endpoint === "opencode-go" ? OPENCODE_GO_ROUTES : OPENCODE_ZEN_ROUTES
  return Object.keys(routes).sort()
}

/**
 * The subset of {@link listOpencodeModelRefs} whose wire surface is the
 * Anthropic Messages API — exactly what the matching `opencode` /
 * `opencode-go` gateway preset can serve, and therefore exactly what an
 * Anthropic-native adapter (claude-code / claude-sdk) may offer on that
 * route. Both endpoints also serve OpenAI chat/completions, OpenAI Responses
 * and (Zen only) Gemini models behind the same base URL; those are
 * unreachable from an Anthropic client and are excluded here.
 *
 * Derived from the generated `*_ANTHROPIC_MODELS` lists, which come from the
 * source's own per-model `provider.npm` discriminator — so an adapter menu
 * built on this can never drift into offering an id the endpoint won't answer
 * on `/v1/messages`, and a newly-added Anthropic-surface model becomes
 * offerable on the next catalog-sync run with no code change (the same
 * rationale as `listNativeModelIds`).
 */
export function listOpencodeAnthropicModelRefs(endpoint: OpencodeEndpoint): string[] {
  const bareIds =
    endpoint === "opencode-go" ? OPENCODE_GO_ANTHROPIC_MODELS : OPENCODE_ZEN_ANTHROPIC_MODELS
  return bareIds.map(id => `${endpoint}/${id}`).sort()
}
