import { createHash } from 'crypto';

/**
 * Capability tier of a route, coarse enough to map onto the four Claude
 * families. Used by {@link toAnthropicStyle} to pick a family prefix for the
 * generated Anthropic-shaped id (see {@link TIER_TO_FAMILY}).
 */
export type ModelTier = 'extra-high' | 'high' | 'medium' | 'small';

export interface ModelRoute {
  provider: string;
  model: string;
  /**
   * Optional Claude-shaped compatibility alias. Committed packs never hardcode
   * this — it is populated either by a local pack (loaded from
   * `packs.local.json`) or on demand by {@link toAnthropicStyle} when a request
   * opts into the Anthropic-style format. Committed packs use
   * provider-transparent model IDs and never pretend to be real Claude models.
   */
  equivalentClaudeName?: string;
  /**
   * Coarse capability tier. Only consumed by {@link toAnthropicStyle} to select
   * a Claude family for the generated alias; ignored on every routing path.
   */
  tier?: ModelTier;
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

// Source: OpenRouter /api/v1/models (fetched 2026-07-16), filtered to openai/*
export const openaiPack: ModelPack = {
  id: 'openai',
  label: 'OpenAI',
  description: 'OpenAI models via the OpenAI-compatible API — synced from OpenRouter catalog',
  models: {
    // ── GPT-5.6 series ──
    'gpt-5.6-luna': { provider: 'openai', model: 'gpt-5.6-luna' },
    'gpt-5.6-luna-pro': { provider: 'openai', model: 'gpt-5.6-luna-pro' },
    'gpt-5.6-terra': { provider: 'openai', model: 'gpt-5.6-terra' },
    'gpt-5.6-terra-pro': { provider: 'openai', model: 'gpt-5.6-terra-pro' },
    'gpt-5.6-sol': { provider: 'openai', model: 'gpt-5.6-sol' },
    'gpt-5.6-sol-pro': { provider: 'openai', model: 'gpt-5.6-sol-pro' },
    // ── GPT-5.5 ──
    'gpt-5.5': { provider: 'openai', model: 'gpt-5.5' },
    'gpt-5.5-pro': { provider: 'openai', model: 'gpt-5.5-pro' },
    // ── GPT-5.4 ──
    'gpt-5.4': { provider: 'openai', model: 'gpt-5.4' },
    'gpt-5.4-mini': { provider: 'openai', model: 'gpt-5.4-mini' },
    'gpt-5.4-nano': { provider: 'openai', model: 'gpt-5.4-nano' },
    'gpt-5.4-pro': { provider: 'openai', model: 'gpt-5.4-pro' },
    'gpt-5.4-image-2': { provider: 'openai', model: 'gpt-5.4-image-2' },
    // ── GPT-5.3 ──
    'gpt-5.3-chat': { provider: 'openai', model: 'gpt-5.3-chat' },
    'gpt-5.3-codex': { provider: 'openai', model: 'gpt-5.3-codex' },
    // ── GPT-5.2 ──
    'gpt-5.2': { provider: 'openai', model: 'gpt-5.2' },
    'gpt-5.2-pro': { provider: 'openai', model: 'gpt-5.2-pro' },
    'gpt-5.2-chat': { provider: 'openai', model: 'gpt-5.2-chat' },
    'gpt-5.2-codex': { provider: 'openai', model: 'gpt-5.2-codex' },
    // ── GPT-5.1 ──
    'gpt-5.1': { provider: 'openai', model: 'gpt-5.1' },
    'gpt-5.1-chat': { provider: 'openai', model: 'gpt-5.1-chat' },
    'gpt-5.1-codex': { provider: 'openai', model: 'gpt-5.1-codex' },
    'gpt-5.1-codex-mini': { provider: 'openai', model: 'gpt-5.1-codex-mini' },
    'gpt-5.1-codex-max': { provider: 'openai', model: 'gpt-5.1-codex-max' },
    // ── GPT-5 ──
    'gpt-5': { provider: 'openai', model: 'gpt-5' },
    'gpt-5-pro': { provider: 'openai', model: 'gpt-5-pro' },
    'gpt-5-mini': { provider: 'openai', model: 'gpt-5-mini' },
    'gpt-5-nano': { provider: 'openai', model: 'gpt-5-nano' },
    'gpt-5-chat': { provider: 'openai', model: 'gpt-5-chat' },
    'gpt-5-codex': { provider: 'openai', model: 'gpt-5-codex' },
    'gpt-chat-latest': { provider: 'openai', model: 'gpt-chat-latest' },
    // ── GPT-5 image ──
    'gpt-5-image': { provider: 'openai', model: 'gpt-5-image' },
    'gpt-5-image-mini': { provider: 'openai', model: 'gpt-5-image-mini' },
    // ── GPT-4.x ──
    'gpt-4.1': { provider: 'openai', model: 'gpt-4.1' },
    'gpt-4.1-mini': { provider: 'openai', model: 'gpt-4.1-mini' },
    'gpt-4.1-nano': { provider: 'openai', model: 'gpt-4.1-nano' },
    'gpt-4o': { provider: 'openai', model: 'gpt-4o' },
    'gpt-4o-mini': { provider: 'openai', model: 'gpt-4o-mini' },
    'gpt-4o-2024-05-13': { provider: 'openai', model: 'gpt-4o-2024-05-13' },
    'gpt-4o-2024-08-06': { provider: 'openai', model: 'gpt-4o-2024-08-06' },
    'gpt-4o-2024-11-20': { provider: 'openai', model: 'gpt-4o-2024-11-20' },
    'gpt-4o-mini-2024-07-18': { provider: 'openai', model: 'gpt-4o-mini-2024-07-18' },
    'gpt-4o-mini-search-preview': { provider: 'openai', model: 'gpt-4o-mini-search-preview' },
    'gpt-4o-search-preview': { provider: 'openai', model: 'gpt-4o-search-preview' },
    'gpt-4': { provider: 'openai', model: 'gpt-4' },
    'gpt-4-turbo': { provider: 'openai', model: 'gpt-4-turbo' },
    'gpt-4-turbo-preview': { provider: 'openai', model: 'gpt-4-turbo-preview' },
    // ── GPT-3.5 (legacy) ──
    'gpt-3.5-turbo': { provider: 'openai', model: 'gpt-3.5-turbo' },
    'gpt-3.5-turbo-16k': { provider: 'openai', model: 'gpt-3.5-turbo-16k' },
    'gpt-3.5-turbo-0613': { provider: 'openai', model: 'gpt-3.5-turbo-0613' },
    'gpt-3.5-turbo-instruct': { provider: 'openai', model: 'gpt-3.5-turbo-instruct' },
    // ── Audio ──
    'gpt-audio': { provider: 'openai', model: 'gpt-audio' },
    'gpt-audio-mini': { provider: 'openai', model: 'gpt-audio-mini' },
    // ── o-series (reasoning) ──
    o1: { provider: 'openai', model: 'o1' },
    'o1-pro': { provider: 'openai', model: 'o1-pro' },
    o3: { provider: 'openai', model: 'o3' },
    'o3-pro': { provider: 'openai', model: 'o3-pro' },
    'o3-mini': { provider: 'openai', model: 'o3-mini' },
    'o3-mini-high': { provider: 'openai', model: 'o3-mini-high' },
    'o3-deep-research': { provider: 'openai', model: 'o3-deep-research' },
    'o4-mini': { provider: 'openai', model: 'o4-mini' },
    'o4-mini-high': { provider: 'openai', model: 'o4-mini-high' },
    'o4-mini-deep-research': { provider: 'openai', model: 'o4-mini-deep-research' },
    // ── OSS ──
    'gpt-oss-20b': { provider: 'openai', model: 'gpt-oss-20b' },
    'gpt-oss-20b:free': { provider: 'openai', model: 'gpt-oss-20b:free' },
    'gpt-oss-120b': { provider: 'openai', model: 'gpt-oss-120b' },
    'gpt-oss-safeguard-20b': { provider: 'openai', model: 'gpt-oss-safeguard-20b' },
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
    // claude-fable-5 is registered in the model catalog (catalog.ts) and
    // context-windows.generated.ts with confirmed pricing. The model ID is
    // used as-is because Anthropic exposes it without a datestamp alias.
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

export const requestyPack: ModelPack = {
  id: 'requesty',
  label: 'Requesty',
  description: 'Source-backed models available through the Requesty router',
  models: {
    // Requesty ids are already vendor-prefixed, so the pack code IS the
    // upstream id — transparent, no aliasing. Claude-name compatibility for
    // this router belongs in a local pack (see packs.local.example.ts).
    'sference/thinkingcap-qwen3.6-27b': {
      provider: 'requesty',
      model: 'sference/thinkingcap-qwen3.6-27b',
    },
    'sference/glm-5.2': { provider: 'requesty', model: 'sference/glm-5.2' },
    'openai/gpt-4.1': { provider: 'requesty', model: 'openai/gpt-4.1' },
    'openai/gpt-4o': { provider: 'requesty', model: 'openai/gpt-4o' },
  },
};

// Curated production coding models, all routed through OpenRouter's native
// Anthropic-compatible endpoint. Provider-transparent (code === upstream id);
// no preview/free routes. Tiers feed toAnthropicStyle only. Cross-check the ids
// against `GET https://openrouter.ai/api/v1/models?supported_parameters=tools`
// when refreshing this list — availability and pricing drift.
export const codingPack: ModelPack = {
  id: 'coding',
  label: 'Coding (OpenRouter)',
  description: 'Curated production coding models routed through OpenRouter',
  models: {
    'openai/gpt-5.5': { provider: 'openrouter', model: 'openai/gpt-5.5', tier: 'extra-high' },
    'anthropic/claude-opus-4.8': { provider: 'openrouter', model: 'anthropic/claude-opus-4.8', tier: 'high' },
    'deepseek/deepseek-v4-pro': { provider: 'openrouter', model: 'deepseek/deepseek-v4-pro', tier: 'high' },
    'anthropic/claude-sonnet-5': { provider: 'openrouter', model: 'anthropic/claude-sonnet-5', tier: 'medium' },
    'z-ai/glm-5.2': { provider: 'openrouter', model: 'z-ai/glm-5.2', tier: 'medium' },
    'minimax/minimax-m3': { provider: 'openrouter', model: 'minimax/minimax-m3', tier: 'small' },
  },
};

// ── Registry ──────────────────────────────────────────────────────────────
// Start with official packs. Local packs are merged at runtime if present.
export const PACK_REGISTRY: Record<string, ModelPack> = {
  [defaultPack.id]: defaultPack,
  [xaiPack.id]: xaiPack,
  [openaiPack.id]: openaiPack,
  [openrouterPack.id]: openrouterPack,
  [requestyPack.id]: requestyPack,
  [anthropicPack.id]: anthropicPack,
  [codingPack.id]: codingPack,
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
  'requesty',
  'zai',
  'groq',
  'xai',
  'openai',
]);

/**
 * Parse a transparent model reference of the form `provider/model`.
 * Returns `{ provider, model }` when the prefix is a known provider, else null.
 * For `openrouter` and `requesty`, the remainder may contain additional slashes
 * (e.g. `openrouter/anthropic/claude-3-5-sonnet-20241022`,
 * `requesty/sference/thinkingcap-qwen3.6-27b`) — the split is on the FIRST
 * slash only, so the router's own vendor prefix survives intact.
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

// ── Anthropic-style format transform ────────────────────────────────────────
// Relabels each route with an opaque, Claude-shaped id so Anthropic-only
// clients get ids they'll accept, WITHOUT impersonating a real Claude model.
// Applied on demand (never committed) when a request opts into the
// Anthropic-style format — see the X-Proxy-Format handling in index.ts.

/** Maps a coarse capability tier onto a Claude family used as the id prefix. */
export const TIER_TO_FAMILY: Record<ModelTier, string> = {
  'extra-high': 'fable',
  high: 'opus',
  medium: 'sonnet',
  small: 'haiku',
};

// Family used when a route carries no tier — a neutral middle default.
const DEFAULT_FAMILY = 'sonnet';

export interface ToAnthropicStyleOptions {
  /** New pack id (defaults to the source pack's id). */
  id?: string;
  /** New label (defaults to the source pack's label). */
  label?: string;
  /** Number of decimal digits in the sha-derived suffix (default 7). */
  digits?: number;
  /** Alias prefix (default "claude-"). */
  idPrefix?: string;
}

/**
 * Derive a deterministic, fixed-length numeric string from a model id via
 * sha256. Distinct upstream ids yield distinct numbers (collision-resistant
 * within a pack); the same id always yields the same number, so ids are stable
 * across process restarts and unit-testable. No Math.random.
 */
export function shaNumericId(model: string, digits = 7): string {
  const hex = createHash('sha256').update(model).digest('hex');
  // 15 hex chars ≈ 60 bits — safely below Number/BigInt-from-hex limits and
  // more than enough entropy for the small pack sizes here.
  const n = BigInt('0x' + hex.slice(0, 15)) % (10n ** BigInt(digits));
  return n.toString().padStart(digits, '0');
}

/**
 * Convert a pack to "Anthropic style": every route keeps its transparent code
 * (the display name) and its real provider/model, and gains an
 * `equivalentClaudeName` of the form `claude-<family>-<sha>`. The family comes
 * from the route's {@link ModelTier} (fallback `sonnet`); the suffix is a
 * sha-derived number of the upstream model id. Pure and deterministic.
 */
export function toAnthropicStyle(pack: ModelPack, opts: ToAnthropicStyleOptions = {}): ModelPack {
  const { digits = 7, idPrefix = 'claude-' } = opts;
  const models: Record<string, ModelRoute> = {};
  for (const [code, route] of Object.entries(pack.models)) {
    const family = route.tier ? TIER_TO_FAMILY[route.tier] : DEFAULT_FAMILY;
    models[code] = {
      ...route,
      equivalentClaudeName: `${idPrefix}${family}-${shaNumericId(route.model, digits)}`,
    };
  }
  return {
    id: opts.id ?? pack.id,
    label: opts.label ?? pack.label,
    description: pack.description,
    models,
  };
}
