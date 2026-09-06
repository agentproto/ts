import type { ProviderPreset } from "./types.js"

/**
 * Env vars to scrub whenever a client fronts ANY Anthropic-compatible gateway
 * (Moonshot, OpenRouter, LiteLLM, …): the ambient native-Anthropic credential
 * must not leak to a third-party host. Named separately from the per-preset
 * `scrubEnv` because a gateway-agnostic surface (e.g. claude-code's `base_url`
 * option, which isn't tied to one preset) needs the core scrub without picking
 * a specific provider. Every Anthropic-flavored preset's `scrubEnv` is this.
 */
export const ANTHROPIC_CORE_SCRUB_ENV = ["ANTHROPIC_API_KEY"] as const

/**
 * Anthropic-compatible gateway presets.
 *
 * Both @agentproto/adapter-claude-code and @agentproto/adapter-claude-sdk front
 * these — the `claude` binary and the Claude Agent SDK both honor
 * `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN`, so any Anthropic-compatible
 * gateway works the same way through either.
 *
 * This is the single source of truth for `baseUrl` / `keyEnv` / `defaultModel`:
 * those are the facts most likely to drift or be copy-pasted wrong across
 * adapters. Adapter-specific projection (cloud-toggle scrubs, `--thinking`,
 * model-tier pinning) stays in the adapter — see each adapter's mode table.
 */
export const ANTHROPIC_GATEWAY_PRESETS = {
  moonshot: {
    id: "moonshot",
    label: "Moonshot (Kimi)",
    description:
      "Moonshot (Kimi) Anthropic-compatible gateway. Kimi models (e.g. " +
      "kimi-k2.7-code) require thinking enabled.",
    schemaFlavor: "anthropic",
    baseUrl: "https://api.moonshot.ai/anthropic",
    keyEnv: "MOONSHOT_API_KEY",
    scrubEnv: ANTHROPIC_CORE_SCRUB_ENV,
    defaultModel: "kimi-k2.7-code",
    homepage: "https://platform.moonshot.ai",
  },
  openrouter: {
    id: "openrouter",
    label: "OpenRouter",
    description:
      "OpenRouter Anthropic-compatible gateway. Any OpenRouter model id " +
      "(e.g. z-ai/glm-5.2, deepseek/deepseek-v4-pro, moonshotai/kimi-k2) " +
      "works via the model option. Base URL carries NO /v1 suffix — the " +
      "client appends /v1/messages itself.",
    schemaFlavor: "anthropic",
    // NOT ".../api/v1": the client appends /v1/messages, so a /v1 here yields
    // /api/v1/v1/messages → 404, which OpenRouter surfaces to the harness as
    // the misleading "model may not exist or you may not have access to it".
    baseUrl: "https://openrouter.ai/api",
    keyEnv: "OPENROUTER_API_KEY",
    scrubEnv: ANTHROPIC_CORE_SCRUB_ENV,
    homepage: "https://openrouter.ai",
  },
  requesty: {
    id: "requesty",
    label: "Requesty",
    description:
      "Requesty router's Anthropic-compatible gateway. Any Requesty model id " +
      "(e.g. sference/thinkingcap-qwen3.6-27b, sference/glm-5.2, " +
      "openai/gpt-4.1) works via the model option — see GET /v1/models for " +
      "the live list. Note the base URL has NO /v1 suffix: the client appends " +
      "/v1/messages itself, and Requesty serves the Anthropic surface at " +
      "/v1/messages (not the /anthropic/v1/messages the docs claim — that 404s).",
    schemaFlavor: "anthropic",
    baseUrl: "https://router.requesty.ai",
    keyEnv: "REQUESTY_API_KEY",
    scrubEnv: ANTHROPIC_CORE_SCRUB_ENV,
    homepage: "https://requesty.ai",
  },
  deepseek: {
    id: "deepseek",
    label: "DeepSeek",
    description:
      "DeepSeek Anthropic-compatible gateway. DeepSeek V4 models " +
      "(deepseek-v4-pro, deepseek-v4-flash) support thinking mode; pick via " +
      "the model option. Auth is Bearer (set via the auth_token option or " +
      "ANTHROPIC_AUTH_TOKEN), matching the moonshot/openrouter shape.",
    schemaFlavor: "anthropic",
    baseUrl: "https://api.deepseek.com/anthropic",
    keyEnv: "DEEPSEEK_API_KEY",
    scrubEnv: ANTHROPIC_CORE_SCRUB_ENV,
    defaultModel: "deepseek-v4-pro",
    homepage: "https://api-docs.deepseek.com",
  },
  "xai-anthropic": {
    id: "xai-anthropic",
    label: "xAI (Anthropic-compatible)",
    description:
      "xAI Grok models via xAI's live Anthropic-compatible Messages endpoint " +
      "at https://api.x.ai/v1/messages. Base URL has NO /v1 suffix — the " +
      "client appends /v1/messages itself. Set XAI_API_KEY in env. Note: " +
      "xAI's own docs do not document this surface, but the endpoint is live " +
      "and returns standard Anthropic message responses.",
    schemaFlavor: "anthropic",
    // NO /v1 suffix: the Anthropic client appends /v1/messages itself.
    baseUrl: "https://api.x.ai",
    keyEnv: "XAI_API_KEY",
    scrubEnv: ANTHROPIC_CORE_SCRUB_ENV,
    defaultModel: "grok-4.5",
    homepage: "https://docs.x.ai",
  },
  "llm-endpoint": {
    id: "llm-endpoint",
    label: "LLM Endpoint",
    description:
      "Local llm-endpoint Anthropic-compatible proxy. Upstream routing is " +
      "decided by the runtime resolver; the client just sees an Anthropic " +
      "Messages surface at localhost:18090. Auth via LLM_ENDPOINT_ACCESS_TOKENS " +
      "— the SAME shared-secret var the proxy's inbound gate accepts (see " +
      "`parseAccessTokens(process.env.LLM_ENDPOINT_ACCESS_TOKENS)` in " +
      "@agentproto/llm-endpoint), so one value serves both the server's " +
      "allow-list and the client's presented bearer.",
    schemaFlavor: "anthropic",
    baseUrl: "http://localhost:18090",
    // The proxy gates inbound requests on LLM_ENDPOINT_ACCESS_TOKENS and reads
    // no other var; LLM_ENDPOINT_API_KEY was dead on both sides (never read by
    // the proxy, never a real client key). Point the client's key-env at the
    // one the gate actually checks so the profile's token reaches it.
    keyEnv: "LLM_ENDPOINT_ACCESS_TOKENS",
    scrubEnv: ANTHROPIC_CORE_SCRUB_ENV,
    defaultModel: "kimi-k2.7-code",
  },
  xai: {
    id: "xai",
    label: "xAI (Grok)",
    description:
      "xAI Grok models via the local LLM endpoint proxy (OpenAI-compatible). " +
      "Use model option with real upstream ids: grok-4.5, grok-4.3, grok-4.20, " +
      "grok-build-0.1. Set XAI_API_KEY in env.",
    schemaFlavor: "openai",
    baseUrl: "http://localhost:18090/v1", // Routed through llm-endpoint proxy
    keyEnv: "XAI_API_KEY",
    scrubEnv: ANTHROPIC_CORE_SCRUB_ENV,
    defaultModel: "grok-4.5",
    homepage: "https://docs.x.ai",
  },
  openai: {
    id: "openai",
    label: "OpenAI",
    description:
      "OpenAI models via the local LLM endpoint proxy (OpenAI-compatible). " +
      "Use model option with real upstream ids: gpt-4.1, gpt-4o, gpt-5, etc. " +
      "Set OPENAI_API_KEY in env.",
    schemaFlavor: "openai",
    baseUrl: "http://localhost:18090/v1",
    keyEnv: "OPENAI_API_KEY",
    scrubEnv: [],
    defaultModel: "gpt-4.1",
    homepage: "https://openai.com/docs",
  },
  "openai-direct": {
    id: "openai-direct",
    label: "OpenAI (direct)",
    description:
      "OpenAI models routed directly to api.openai.com (OpenAI-compatible). " +
      "Use model option with real upstream ids: gpt-4.1, gpt-5, etc. " +
      "Set OPENAI_API_KEY in env. No local proxy — direct to OpenAI.",
    schemaFlavor: "openai",
    baseUrl: "https://api.openai.com/v1",
    keyEnv: "OPENAI_API_KEY",
    scrubEnv: [],
    defaultModel: "gpt-4.1",
    homepage: "https://platform.openai.com",
  },
  mistral: {
    id: "mistral",
    label: "Mistral",
    description:
      "Mistral models direct to api.mistral.ai (OpenAI-compatible). Use the " +
      "model option with Mistral ids (e.g. mistral-large-latest, " +
      "codestral-latest — the -latest aliases are Mistral's own stable " +
      "pointers). Set MISTRAL_API_KEY in env.",
    schemaFlavor: "openai",
    baseUrl: "https://api.mistral.ai/v1",
    keyEnv: "MISTRAL_API_KEY",
    scrubEnv: [],
    defaultModel: "mistral-large-latest",
    homepage: "https://docs.mistral.ai",
  },
  groq: {
    id: "groq",
    label: "Groq",
    description:
      "Groq LPU inference direct to api.groq.com (OpenAI-compatible; note " +
      "the /openai path segment in the base URL). Open-weight models at very " +
      "high tokens/s — see GET /models for the live list; no pinned default, " +
      "the lineup rotates. Set GROQ_API_KEY in env.",
    schemaFlavor: "openai",
    baseUrl: "https://api.groq.com/openai/v1",
    keyEnv: "GROQ_API_KEY",
    scrubEnv: [],
    homepage: "https://console.groq.com/docs",
  },
  nebius: {
    id: "nebius",
    label: "Nebius AI Studio",
    description:
      "Nebius AI Studio direct to api.studio.nebius.com (OpenAI-compatible). " +
      "Open-weight chat models plus embeddings (e.g. BAAI/bge-m3) — see " +
      "GET /models for the live list; no pinned default. Set NEBIUS_API_KEY " +
      "in env (Studio-era auth0 JWTs were invalidated by their IAM " +
      "migration — mint a fresh key in the Studio console if auth fails " +
      "with a non-expired token).",
    schemaFlavor: "openai",
    baseUrl: "https://api.studio.nebius.com/v1",
    keyEnv: "NEBIUS_API_KEY",
    scrubEnv: [],
    homepage: "https://studio.nebius.com",
  },
  huggingface: {
    id: "huggingface",
    label: "Hugging Face (Inference Providers)",
    description:
      "Hugging Face Inference Providers router (OpenAI-compatible). Model " +
      "ids are Hub repo ids (e.g. moonshotai/Kimi-K3, deepseek-ai/…) — the " +
      "router picks a backing provider per model; see GET /models for the " +
      "live list; no pinned default. Set HF_TOKEN in env (the ecosystem-wide " +
      "HF convention — not an *_API_KEY name).",
    schemaFlavor: "openai",
    baseUrl: "https://router.huggingface.co/v1",
    keyEnv: "HF_TOKEN",
    scrubEnv: [],
    homepage: "https://huggingface.co/docs/inference-providers",
  },
  deepinfra: {
    id: "deepinfra",
    label: "DeepInfra",
    description:
      "DeepInfra direct to api.deepinfra.com (OpenAI-compatible; note the " +
      "/v1/openai path). Open-weight chat models plus embeddings at " +
      "per-token pricing — see GET /models for the live list; no pinned " +
      "default. Set DEEPINFRA_API_KEY in env.",
    schemaFlavor: "openai",
    baseUrl: "https://api.deepinfra.com/v1/openai",
    keyEnv: "DEEPINFRA_API_KEY",
    scrubEnv: [],
    homepage: "https://deepinfra.com/docs",
  },
} as const satisfies Record<string, ProviderPreset>

export type AnthropicGatewayPresetId = keyof typeof ANTHROPIC_GATEWAY_PRESETS

/** Flat list form for catalog UIs / `agentproto presets list`. */
export const anthropicGatewayPresetList: ProviderPreset[] = [
  ...Object.values(ANTHROPIC_GATEWAY_PRESETS),
]

/**
 * Look up a preset by id. Throws on unknown id so a typo in an adapter
 * manifest fails loudly at load rather than silently shipping a mode with no
 * base URL.
 */
export function getAnthropicGatewayPreset(
  id: AnthropicGatewayPresetId
): ProviderPreset {
  const preset = findAnthropicGatewayPreset(id)
  if (!preset) {
    throw new Error(
      `Unknown Anthropic gateway preset: "${id}". Known: ${Object.keys(
        ANTHROPIC_GATEWAY_PRESETS
      ).join(", ")}.`
    )
  }
  return preset
}

/**
 * Safe preset lookup — returns undefined for unknown ids so runtime resolvers
 * can fall back to model/provider/custom-route resolution.
 */
export function findAnthropicGatewayPreset(id: string): ProviderPreset | undefined {
  return ANTHROPIC_GATEWAY_PRESETS[id as AnthropicGatewayPresetId]
}
