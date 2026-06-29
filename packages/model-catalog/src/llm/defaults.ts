/**
 * Curated, SDK-ready LLM model ids.
 *
 * Centralizes the version-specific provider ids used at runtime so call
 * sites stop carrying string literals. Pricing for each is resolved
 * automatically through `MODEL_ALIASES` in `catalog.ts` (e.g.
 * `claude-sonnet-4-6` → `claude-sonnet-4-5`).
 *
 * Update one constant here when bumping the platform-wide default —
 * every workflow step and operator config picks up the new id with a
 * single rebuild.
 */

/** Fast workhorse for content workflows (outline, post, sections). */
export const WORKFLOW_FAST_MODEL = "claude-sonnet-4-6" as const

/** Premium tier for high-stakes generation (rarely used in workflows). */
export const WORKFLOW_PREMIUM_MODEL = "claude-opus-4-6" as const

/** Cheap-and-quick for short outputs like titles. */
export const WORKFLOW_TINY_MODEL = "claude-haiku-4-5-20251001" as const

/**
 * Models eligible for operator agents (an app). Keep in sync with the
 * agent-framework's model-provider config. The literal tuple drives the
 * `OperatorAgentModel` union type below.
 */
export const OPERATOR_AGENT_MODELS = [
  "claude-opus-4-5",
  "claude-sonnet-4-5",
  "gemini-3.1-pro-preview",
] as const

export type OperatorAgentModel = (typeof OPERATOR_AGENT_MODELS)[number]

/** Default operator model when no explicit choice is made. */
export const OPERATOR_DEFAULT_PREMIUM: OperatorAgentModel = "claude-opus-4-5"
export const OPERATOR_DEFAULT_STANDARD: OperatorAgentModel = "claude-sonnet-4-5"
export const OPERATOR_DEFAULT_GEMINI: OperatorAgentModel =
  "gemini-3.1-pro-preview"

// ── Plan-tier → model lists ─────────────────────────────────────────────
//
// Catalog-canonical equivalent of agent-framework's `MODEL_TIERS`. Used
// by per-app `AppPlanRegistry` files as the source list when a plan
// surfaces "all of the X tier". Keeping this in the catalog keeps the
// app registries declarative — they pick from `LLM_TIERS.plus` rather
// than re-specifying ids.
//
// All ids resolve through `resolvePricing` (direct match → alias →
// partial-prefix). Names are app-vocabulary-neutral; per-app registries
// re-key as needed (`PaygoTier.nano` → `LLM_TIERS.nano`, etc.).

export const LLM_TIERS = {
  /** Cheap-and-quick. Single-model fallback. */
  nano: ["mistral-small-creative-latest"] as const,
  /** Low-cost, agentic-capable. Direct alt-providers. */
  mini: [
    "MiniMax-M2.5",
    "MiniMax-M2.1",
    "MiniMax-M2",
    "mistral-large-latest",
  ] as const,
  /** Medium cost, fast inference + good general perf. OpenRouter-routed. */
  lite: [
    "x-ai/grok-4-fast",
    "xiaomi/mimo-v2-flash",
    "google/gemini-3-flash-preview",
  ] as const,
  /** High quality, premium features. Mix of direct + OpenRouter. */
  plus: [
    "claude-sonnet-4-5",
    "gpt-4o",
    "kimi-k2.5",
    "deepseek/deepseek-v3.2",
  ] as const,
  /** Top-tier, best performance. */
  pro: [
    "claude-opus-4-5",
    "google/gemini-3.1-pro-preview",
    "kimi-k2-thinking",
  ] as const,
} as const

export type LlmTierName = keyof typeof LLM_TIERS
