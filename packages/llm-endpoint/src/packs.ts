export interface ModelRoute {
  provider: string;
  model: string;
  /**
   * Optional Claude-shaped compatibility alias. Only local packs (loaded from
   * `packs.local.json`) should populate this field. Public committed packs use
   * provider-transparent model IDs and never pretend to be real Claude models.
   */
  equivalentClaudeName?: string;
}

/**
 * A pack is a curated set of model routes. Packs solve the collision problem
 * when multiple providers share the same display name, and they let users opt
 * into local compatibility aliases for clients that only speak the Anthropic
 * model namespace.
 *
 * Selection methods:
 *   - URL path: /v1/{packId}/messages → pack = {packId}
 *   - Query param: /v1/messages?pack={packId}
 *   - Header: X-Proxy-Pack: {packId}
 *   - Default: no pack specified → uses 'default' pack
 */

export interface ModelPack {
  id: string;
  label: string;
  description: string;
  models: Record<string, ModelRoute>;
}

// ── Official packs (committed) ─────────────────────────────────────────────
// These are public, provider-transparent model routes. They never contain
// private codenames or bare Claude aliases mapping to non-Anthropic targets.
// For Claude compatibility aliases, use a local pack (packs.local.json).

export const defaultPack: ModelPack = {
  id: 'default',
  label: 'Default transparent routes',
  description: 'Provider-transparent model IDs routed directly to each backend',
  models: {
    'kimi-k2.7-code': { provider: 'moonshot', model: 'kimi-k2.7-code' },
    'kimi-k2.6': { provider: 'moonshot', model: 'kimi-k2.6' },
    'llama-3.3-70b-versatile': { provider: 'groq', model: 'llama-3.3-70b-versatile' },
    'qwen/qwen3.6-27b': { provider: 'groq', model: 'qwen/qwen3.6-27b' },
    'glm-5.2': { provider: 'zai', model: 'glm-5.2' },
    'gpt-4.1': { provider: 'openai', model: 'gpt-4.1' },
    'gpt-4o': { provider: 'openai', model: 'gpt-4o' },
    'gpt-4o-mini': { provider: 'openai', model: 'gpt-4o-mini' },
  },
};

export const xaiPack: ModelPack = {
  id: 'xai',
  label: 'xAI (Grok)',
  description: 'xAI Grok models via the OpenAI-compatible API',
  models: {
    'grok-4.5': { provider: 'xai', model: 'grok-4.5' },
    'grok-4.3': { provider: 'xai', model: 'grok-4.3' },
    'grok-4.20': { provider: 'xai', model: 'grok-4.20' },
    'grok-build-0.1': { provider: 'xai', model: 'grok-build-0.1' },
  },
};

export const openaiPack: ModelPack = {
  id: 'openai',
  label: 'OpenAI',
  description: 'OpenAI models via the OpenAI-compatible API',
  models: {
    'gpt-5.6-luna': { provider: 'openai', model: 'gpt-5.6-luna' },
    'gpt-5.6-luna-pro': { provider: 'openai', model: 'gpt-5.6-luna-pro' },
    'gpt-5.6-terra': { provider: 'openai', model: 'gpt-5.6-terra' },
    'gpt-5.6-terra-pro': { provider: 'openai', model: 'gpt-5.6-terra-pro' },
    'gpt-5.6-sol': { provider: 'openai', model: 'gpt-5.6-sol' },
    'gpt-5.6-sol-pro': { provider: 'openai', model: 'gpt-5.6-sol-pro' },
    'gpt-5.5': { provider: 'openai', model: 'gpt-5.5' },
    'gpt-5.5-pro': { provider: 'openai', model: 'gpt-5.5-pro' },
    'gpt-5.4': { provider: 'openai', model: 'gpt-5.4' },
    'gpt-5.4-mini': { provider: 'openai', model: 'gpt-5.4-mini' },
    'gpt-5.4-nano': { provider: 'openai', model: 'gpt-5.4-nano' },
    'gpt-5.4-pro': { provider: 'openai', model: 'gpt-5.4-pro' },
    'gpt-5.3': { provider: 'openai', model: 'gpt-5.3' },
    'gpt-5.3-mini': { provider: 'openai', model: 'gpt-5.3-mini' },
    'gpt-5.2': { provider: 'openai', model: 'gpt-5.2' },
    'gpt-5.2-mini': { provider: 'openai', model: 'gpt-5.2-mini' },
    'gpt-5.2-pro': { provider: 'openai', model: 'gpt-5.2-pro' },
    'gpt-5.2-codex': { provider: 'openai', model: 'gpt-5.2-codex' },
    'gpt-5.2-codex-mini': { provider: 'openai', model: 'gpt-5.2-codex-mini' },
    'gpt-5.2-codex-max': { provider: 'openai', model: 'gpt-5.2-codex-max' },
    'gpt-5.1': { provider: 'openai', model: 'gpt-5.1' },
    'gpt-5.1-mini': { provider: 'openai', model: 'gpt-5.1-mini' },
    'gpt-5.1-codex': { provider: 'openai', model: 'gpt-5.1-codex' },
    'gpt-5.1-codex-mini': { provider: 'openai', model: 'gpt-5.1-codex-mini' },
    'gpt-5.1-codex-max': { provider: 'openai', model: 'gpt-5.1-codex-max' },
    'gpt-5-mini': { provider: 'openai', model: 'gpt-5-mini' },
    'gpt-5-nano': { provider: 'openai', model: 'gpt-5-nano' },
    'gpt-5-codex': { provider: 'openai', model: 'gpt-5-codex' },
    'gpt-5-pro': { provider: 'openai', model: 'gpt-5-pro' },
    'gpt-5-image': { provider: 'openai', model: 'gpt-5-image' },
    'gpt-5-image-mini': { provider: 'openai', model: 'gpt-5-image-mini' },
    'gpt-5': { provider: 'openai', model: 'gpt-5' },
    'gpt-4.1': { provider: 'openai', model: 'gpt-4.1' },
    'gpt-4.1-mini': { provider: 'openai', model: 'gpt-4.1-mini' },
    'gpt-4.1-nano': { provider: 'openai', model: 'gpt-4.1-nano' },
    'gpt-4o': { provider: 'openai', model: 'gpt-4o' },
    'gpt-4o-mini': { provider: 'openai', model: 'gpt-4o-mini' },
    'gpt-audio': { provider: 'openai', model: 'gpt-audio' },
    'gpt-audio-mini': { provider: 'openai', model: 'gpt-audio-mini' },
    'o3-pro': { provider: 'openai', model: 'o3-pro' },
    'o3-deep-research': { provider: 'openai', model: 'o3-deep-research' },
    'o4-mini-high': { provider: 'openai', model: 'o4-mini-high' },
    'o4-mini-deep-research': { provider: 'openai', model: 'o4-mini-deep-research' },
    'o1-pro': { provider: 'openai', model: 'o1-pro' },
  },
};

export const anthropicPack: ModelPack = {
  id: 'anthropic',
  label: 'Anthropic (direct)',
  description: 'Claude models routed directly to api.anthropic.com via ANTHROPIC_API_KEY',
  models: {
    'claude-opus-4-8': { provider: 'anthropic', model: 'claude-opus-4-8' },
    'claude-sonnet-5': { provider: 'anthropic', model: 'claude-sonnet-5' },
    // Unlike the other entries here, Anthropic's live /v1/models does not
    // expose a bare "claude-haiku-4-5" id — only the datestamped one
    // resolves (verified against a live models-list fetch; see
    // packages/model-catalog/src/llm/context-windows.generated.ts). Do not
    // "fix" this to match the other entries — that would 404 upstream.
    'claude-haiku-4-5': { provider: 'anthropic', model: 'claude-haiku-4-5-20251001' },
    'claude-fable-5': { provider: 'anthropic', model: 'claude-fable-5' },
  },
};

export const openrouterPack: ModelPack = {
  id: 'openrouter',
  label: 'OpenRouter',
  description: 'Source-backed models available through OpenRouter',
  models: {
    'anthropic/claude-3-5-sonnet-20241022': {
      provider: 'openrouter',
      model: 'anthropic/claude-3-5-sonnet-20241022',
      equivalentClaudeName: 'claude-3-5-sonnet-20241022',
    },
    'anthropic/claude-3-opus-20240229': {
      provider: 'openrouter',
      model: 'anthropic/claude-3-opus-20240229',
      equivalentClaudeName: 'claude-3-opus-20240229',
    },
    'openai/gpt-4o': { provider: 'openrouter', model: 'openai/gpt-4o' },
    'openai/gpt-4o-mini': { provider: 'openrouter', model: 'openai/gpt-4o-mini' },
  },
};

// ── Registry ──────────────────────────────────────────────────────────────
// Start with official packs. Local packs are merged at runtime if present.
export const PACK_REGISTRY: Record<string, ModelPack> = {
  [defaultPack.id]: defaultPack,
  [xaiPack.id]: xaiPack,
  [openaiPack.id]: openaiPack,
  [openrouterPack.id]: openrouterPack,
  [anthropicPack.id]: anthropicPack,
};

// Default pack used when no pack is specified.
export const DEFAULT_PACK_ID = 'default';

/**
 * Resolve a pack by ID from the official registry.
 * Returns the default pack when packId is null/undefined.
 * Throws a RangeError for non-null IDs that are not in the registry —
 * callers that need silent fallback should check `PACK_REGISTRY[id]` first.
 */
export function resolvePack(packId: string | null | undefined): ModelPack {
  if (!packId) return PACK_REGISTRY[DEFAULT_PACK_ID]!;
  const pack = PACK_REGISTRY[packId];
  if (!pack) throw new RangeError(`Unknown pack id: "${packId}". Available: ${Object.keys(PACK_REGISTRY).join(', ')}`);
  return pack;
}

/**
 * Build a flat route mapping from a pack.
 */
export function buildMappingFromPack(pack: ModelPack): Record<string, ModelRoute> {
  return { ...pack.models };
}

/**
 * List all available pack IDs for discovery.
 */
export function listPackIds(): string[] {
  return Object.keys(PACK_REGISTRY);
}

/**
 * Providers that support transparent `provider/model` routing on the OpenAI
 * chat/completions and Responses surfaces. This is the allow-list for both
 * `?p=` overrides and model-id prefixes.
 */
export const KNOWN_TRANSPARENT_PROVIDERS = new Set([
  'anthropic',
  'moonshot',
  'openrouter',
  'zai',
  'groq',
  'xai',
  'openai',
]);

/**
 * Parse a transparent model reference of the form `provider/model`.
 * Returns `{ provider, model }` when the prefix is a known provider, else null.
 * For `openrouter`, the remainder may contain additional slashes (e.g.
 * `openrouter/anthropic/claude-3-5-sonnet-20241022`).
 */
export function parseTransparentModel(model: string): { provider: string; model: string } | null {
  const slashIdx = model.indexOf('/');
  if (slashIdx <= 0 || slashIdx === model.length - 1) return null;
  const provider = model.slice(0, slashIdx);
  if (!KNOWN_TRANSPARENT_PROVIDERS.has(provider)) return null;
  return { provider, model: model.slice(slashIdx + 1) };
}

/**
 * Wildcard/pattern matching helper for tool names.
 * Supports exact match and trailing wildcard: "agentproto_*" matches "agentproto_start",
 * "prefix*" matches "prefixFoo", "*" matches everything.
 */
export function matchesPattern(name: string, pattern: string): boolean {
  return pattern.endsWith('*') ? name.startsWith(pattern.slice(0, -1)) : name === pattern;
}
