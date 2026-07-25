/**
 * @agentproto/provider-presets — concrete provider/backend preset registry.
 *
 * A `ProviderPreset` is the shared, adapter-agnostic facts about a backend an
 * Anthropic/OpenAI-compatible client can front: base URL, the conventional env
 * var holding its API key, the core env vars to scrub, and an optional default
 * model. This is DATA ONLY.
 *
 * Layering: the registry does not know about claude-code vs claude-sdk. How a
 * given adapter projects a preset into its own manifest (modes, options,
 * `env_unset`, `bin_args_append`) stays in the adapter — data flows down,
 * projection stays in the consumer. That keeps @agentproto/provider-kit (the
 * catalog *mechanics*) and the generic @agentproto/driver-agent-cli both free
 * of concrete provider URLs.
 *
 * The user-facing catalog (Stage 2: `agentproto presets list` + a daemon
 * endpoint) lists directly off this shape, composing @agentproto/provider-kit's
 * lister/wizard over this package's data.
 */
export interface ProviderPreset {
  /**
   * Stable id reused as the mode id in adapters (`moonshot`, `openrouter`).
   * Must equal the registry key.
   */
  id: string
  /** Human label for the catalog UI ("Moonshot (Kimi)"). */
  label: string
  /** Short, provider-agnostic description adapters may reuse in mode docs. */
  description: string
  /** API schema flavor — selects which adapter family can consume the preset. */
  schemaFlavor: "anthropic" | "openai"
  /** Base URL the client hits. */
  baseUrl: string
  /**
   * Conventional env var holding this provider's API key
   * (e.g. MOONSHOT_API_KEY, OPENROUTER_API_KEY) — the STORE lookup key
   * (`agentproto auth provider set <id> <key>` / `providers.json`), not
   * necessarily the var injected into every consuming adapter's child env.
   * An adapter that receives a gateway bearer on a DIFFERENT var than this
   * one declares `AgentCliDefinition.gatewayAuth.setEnv` (e.g. claude-sdk /
   * claude-code inject it as `ANTHROPIC_AUTH_TOKEN`, since that's what the
   * Anthropic SDK/CLI actually read); the runtime's `resolveAuthSpec` honors
   * that declaration for gateway routes. An adapter with no `gatewayAuth`
   * (hermes) reads this var directly. (There is no
   * `CLAUDE_SDK_GATEWAY_KEY_ENV` auto-resolution — that was a stale claim;
   * `gatewayAuth` is the real, implemented mechanism.)
   */
  keyEnv: string
  /**
   * Core env vars to scrub when this preset is active, so an ambient
   * credential for the native provider can't leak to the third-party host.
   * Adapters MAY extend this (claude-code adds the CLAUDE_CODE_USE_* cloud
   * redirect toggles); adapters with a runtime scrub (claude-sdk) may ignore
   * it for the manifest and scrub in code. Readonly — registry data is
   * immutable; adapters spread it into a fresh mutable array when projecting.
   */
  scrubEnv: readonly string[]
  /** Conventional default model id for this provider, if any. */
  defaultModel?: string
  /** Optional homepage/docs URL for the catalog UI. */
  homepage?: string
}
