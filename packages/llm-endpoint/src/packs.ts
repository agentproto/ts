export interface SecretTarget {
  provider: string;
  model: string;
  equivalentClaudeName: string;
}

/**
 * A pack is a curated set of up to 8 models with unique equivalentClaudeNames.
 * Packs solve the collision problem when multiple providers share the same
 * Anthropic model name alias.
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
  models: Record<string, SecretTarget>;
}

// ── Official packs (committed) ─────────────────────────────────────────────
// These are public, provider-sanctioned model routes. Keep this minimal.
// For private/custom packs, use packs.local.ts (gitignored).

export const anthropicPack: ModelPack = {
  id: 'anthropic',
  label: 'Anthropic',
  description: 'Native Anthropic models via OpenRouter',
  models: {
    'neptune-4': { provider: 'openrouter', model: 'anthropic/claude-sonnet-4.6', equivalentClaudeName: 'claude-sonnet-4-6' },
    'saturn-5': { provider: 'openrouter', model: 'deepseek/deepseek-v4-pro', equivalentClaudeName: 'claude-sonnet-5' },
    'uranus-8': { provider: 'openrouter', model: 'google/gemini-3.1-pro-preview', equivalentClaudeName: 'claude-fable-5' },
  },
};

export const xaiPack: ModelPack = {
  id: 'xai',
  label: 'xAI (Grok)',
  description: 'xAI Grok models via OpenAI-compatible API',
  models: {
    'nova-1': { provider: 'xai', model: 'grok-4.5', equivalentClaudeName: 'claude-opus-4-8-xai' },
    'pulsar-2': { provider: 'xai', model: 'grok-4.3', equivalentClaudeName: 'claude-sonnet-5-xai' },
    'quasar-3': { provider: 'xai', model: 'grok-4.20', equivalentClaudeName: 'claude-fable-5-xai' },
    'comet-4': { provider: 'xai', model: 'grok-build-0.1', equivalentClaudeName: 'claude-haiku-4-5-xai' },
  },
};

export const openrouterPack: ModelPack = {
  id: 'openrouter',
  label: 'OpenRouter',
  description: 'Popular non-Anthropic models via OpenRouter and other providers',
  models: {
    'jupiter-7': { provider: 'moonshot', model: 'kimi-k2.7-code', equivalentClaudeName: 'claude-opus-4-8' },
    'mars-6': { provider: 'moonshot', model: 'kimi-k2.6', equivalentClaudeName: 'claude-3-opus' },
    'halley-1': { provider: 'openrouter', model: 'deepseek/deepseek-v4-flash', equivalentClaudeName: 'claude-fable-4' },
    'pluto-2': { provider: 'groq', model: 'qwen/qwen3.6-27b', equivalentClaudeName: 'claude-haiku-4-5' },
    'mercury-9': { provider: 'openrouter', model: 'zai/zai-v1', equivalentClaudeName: 'claude-haiku-4-5-mercury' },
    'orion-2': { provider: 'openrouter', model: 'mimo-ai/mimo-v2.5', equivalentClaudeName: 'claude-sonnet-4-5-orion' },
    'pegasus-3': { provider: 'openrouter', model: 'minimax/minimax-m3', equivalentClaudeName: 'claude-opus-4-5-pegasus' },
    'lyra-4': { provider: 'openrouter', model: 'moonshotai/kimi-k2.5', equivalentClaudeName: 'claude-fable-5-lyra' },
    'vega-5': { provider: 'openrouter', model: 'stepfun/step-3.7-flash', equivalentClaudeName: 'claude-haiku-4-5-vega' },
    'venus-3': { provider: 'openrouter', model: 'zai/zai-v1', equivalentClaudeName: 'claude-sonnet-4-6-venus' },
    'atlas-6': { provider: 'openrouter', model: 'meta-llama/llama-3.3-70b', equivalentClaudeName: 'claude-sonnet-4-5-atlas' },
    'titan-7': { provider: 'openrouter', model: 'openai/gpt-oss-120b', equivalentClaudeName: 'claude-opus-4-8-titan' },
  },
};

// ── Registry ──────────────────────────────────────────────────────────────
// Start with official packs. Local packs are merged at runtime if present.
export const PACK_REGISTRY: Record<string, ModelPack> = {
  [anthropicPack.id]: anthropicPack,
  [xaiPack.id]: xaiPack,
  [openrouterPack.id]: openrouterPack,
};

// Default pack used when no pack is specified.
export const DEFAULT_PACK_ID = 'openrouter';

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
 * Build a flat SECRET_CODE_MAPPING from a pack.
 */
export function buildMappingFromPack(pack: ModelPack): Record<string, SecretTarget> {
  return { ...pack.models };
}

/**
 * List all available pack IDs for discovery.
 */
export function listPackIds(): string[] {
  return Object.keys(PACK_REGISTRY);
}

/**
 * Wildcard/pattern matching helper for tool names.
 * Supports exact match and trailing wildcard: "agentproto_*" matches "agentproto_start",
 * "prefix*" matches "prefixFoo", "*" matches everything.
 */
export function matchesPattern(name: string, pattern: string): boolean {
  return pattern.endsWith('*') ? name.startsWith(pattern.slice(0, -1)) : name === pattern;
}
