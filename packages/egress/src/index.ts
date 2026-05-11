/**
 * @agentproto/egress — outbound traffic control for agent sandboxes.
 *
 * Three concerns, each its own module:
 *
 *   - **modes** — registry of egress modes (off / cooperative / strict /
 *     paranoid) with declarative flags hosts branch on at bootstrap
 *     time.
 *
 *   - **providers** — allowlist of upstream URLs the proxy is willing
 *     to forward to. Hosts compose their own subset.
 *
 *   - **proxy** — transport-agnostic core that takes a normalized
 *     request shape + a secret resolver and returns the rewritten
 *     outbound request. Cooperative mode's substitution machinery
 *     comes from `@agentproto/secrets/exposure`.
 *
 * No dependency on Hono, Express, etc. — adapters live per-host.
 */

export {
  type EgressModeId,
  type EgressModeDefinition,
  EgressModeRegistry,
  DEFAULT_EGRESS_MODES,
  createDefaultEgressModeRegistry,
} from "./modes.js"

export {
  type EgressProvider,
  COMMON_EGRESS_PROVIDERS,
  composeEgressProviders,
} from "./providers.js"

export {
  type EgressRequest,
  type RewrittenEgressRequest,
  type ProxyEgressRequestOptions,
  proxyEgressRequest,
  EgressError,
} from "./proxy.js"
