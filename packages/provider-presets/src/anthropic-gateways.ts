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
      "works via the model option.",
    schemaFlavor: "anthropic",
    baseUrl: "https://openrouter.ai/api/v1",
    keyEnv: "OPENROUTER_API_KEY",
    scrubEnv: ANTHROPIC_CORE_SCRUB_ENV,
    homepage: "https://openrouter.ai",
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
  const preset = ANTHROPIC_GATEWAY_PRESETS[id]
  if (!preset) {
    throw new Error(
      `Unknown Anthropic gateway preset: "${id}". Known: ${Object.keys(
        ANTHROPIC_GATEWAY_PRESETS
      ).join(", ")}.`
    )
  }
  return preset
}
