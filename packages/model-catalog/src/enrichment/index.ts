/**
 * Model enrichment — `catalogPriceTier` / `tags` / `lifecycle` / `actions`
 * per model id.
 *
 * Bridge between the legacy data shape (`ImageModelDefinition`,
 * `VideoModelDefinition`, `LLMPricing`) and the v2 access-rule
 * primitives that target by tier, tag, and action. Without this, rules
 * like `priceTier:premium` and `tag:nsfw` would never match anything.
 *
 * Two layers:
 *   1. Explicit map for the curated set we know about (overrides win).
 *   2. Heuristic inference for any model not in the explicit map
 *      (catalogPriceTier from creditCost / token rates; tags from kind +
 *      provider).
 *
 * Actions (`<kind>:<verb>` — e.g. `image:generate`, `llm:tool_use`) are
 * computed from per-kind capability objects via `getActions` and merged
 * into `tags` so existing tag-based access rules match action targets
 * without any evaluator change. The reserved `<kind>:` prefix is enforced
 * by `assertReservedPrefixDiscipline` at module load — free-form curation
 * tags must NOT use it.
 *
 * Add an entry to `EXPLICIT_ENRICHMENT` when you want exact control;
 * skip it when defaults are good enough.
 */

import type { CatalogPriceTier, Lifecycle, ModelKind } from "../schema/index.js"
import type { ResolvedModel } from "../registry/index.js"
import { DEFAULT_PRICING } from "../llm/index.js"
import {
  getActions,
  assertReservedPrefixDiscipline,
} from "../registry/actions.js"

export interface ModelEnrichment {
  catalogPriceTier: CatalogPriceTier
  /** Curation tags + action tags (`<kind>:<verb>`) merged. */
  tags: readonly string[]
  lifecycle: Lifecycle
  /** Action tags only — convenience subset of `tags`. */
  actions: readonly string[]
}

/**
 * Internal shape for the curated explicit-enrichment map. The map carries
 * only the *curation* fields — `tags` here is curation-only (no action
 * tags). `getEnrichment` adds derived `actions` and merges them into
 * `tags` at read time.
 */
interface ExplicitEnrichment {
  catalogPriceTier: CatalogPriceTier
  tags: readonly string[]
  lifecycle: Lifecycle
}

const EXPLICIT_ENRICHMENT: Record<string, ExplicitEnrichment> = {
  // ── LLM ──────────────────────────────────────────────────────────────
  "claude-opus-4-5": {
    catalogPriceTier: "premium",
    tags: ["llm", "anthropic", "premium", "reasoning"],
    lifecycle: "stable",
  },
  "claude-sonnet-4-5": {
    catalogPriceTier: "high",
    tags: ["llm", "anthropic"],
    lifecycle: "stable",
  },
  "claude-haiku-4-5": {
    catalogPriceTier: "low",
    tags: ["llm", "anthropic", "fast"],
    lifecycle: "stable",
  },
  "gemini-2.5-flash": {
    catalogPriceTier: "low",
    tags: ["llm", "google", "fast"],
    lifecycle: "stable",
  },
  "gemini-2.5-pro": {
    catalogPriceTier: "mid",
    tags: ["llm", "google", "reasoning"],
    lifecycle: "stable",
  },
  "gpt-4.1": {
    catalogPriceTier: "mid",
    tags: ["llm", "openai"],
    lifecycle: "stable",
  },
  "gpt-4.1-mini": {
    catalogPriceTier: "low",
    tags: ["llm", "openai", "fast"],
    lifecycle: "stable",
  },
  "gpt-4o": {
    catalogPriceTier: "mid",
    tags: ["llm", "openai"],
    lifecycle: "stable",
  },
  "gpt-4o-mini": {
    catalogPriceTier: "low",
    tags: ["llm", "openai", "fast"],
    lifecycle: "stable",
  },

  // ── Image (highlights — others fall through to heuristic) ────────────
  "nano-banana-pro": {
    catalogPriceTier: "high",
    tags: ["image", "google", "high-quality", "text-rendering"],
    lifecycle: "stable",
  },
  "nano-banana-2": {
    catalogPriceTier: "mid",
    tags: ["image", "google"],
    lifecycle: "stable",
  },
  "nano-banana": {
    catalogPriceTier: "low",
    tags: ["image", "google", "fast"],
    lifecycle: "stable",
  },
  "flux-2-dev": {
    catalogPriceTier: "low",
    tags: ["image", "bfl", "flux"],
    lifecycle: "stable",
  },
  "flux-kontext-pro": {
    catalogPriceTier: "low",
    tags: ["image", "bfl", "flux", "edit"],
    lifecycle: "stable",
  },
  "flux-kontext-max": {
    catalogPriceTier: "mid",
    tags: ["image", "bfl", "flux", "edit", "high-quality"],
    lifecycle: "stable",
  },
  "seedream-4": {
    catalogPriceTier: "low",
    tags: ["image", "bytedance", "photorealistic"],
    lifecycle: "stable",
  },

  // ── Video (highlights) ──────────────────────────────────────────────
  "google/veo-3.1": {
    catalogPriceTier: "high",
    tags: ["video", "google", "veo", "high-quality", "audio"],
    lifecycle: "stable",
  },
  "google/veo-3.1-fast": {
    catalogPriceTier: "mid",
    tags: ["video", "google", "veo", "fast", "audio"],
    lifecycle: "stable",
  },
  "kwaivgi/kling-v2.5-turbo-pro": {
    catalogPriceTier: "low",
    tags: ["video", "kling", "fast"],
    lifecycle: "deprecated",
  },
}

// Module-load lint: every curation tag in the explicit map must avoid the
// reserved `<kind>:` prefix. Action tags are derived by `getActions`,
// never written by hand.
for (const entry of Object.values(EXPLICIT_ENRICHMENT)) {
  assertReservedPrefixDiscipline(entry.tags)
}

/**
 * Heuristic catalogPriceTier — used when an entry has no explicit
 * enrichment. Buckets are intentionally generous so rules don't need
 * every model priced exactly.
 */
function inferCatalogPriceTier(model: ResolvedModel): CatalogPriceTier {
  switch (model.kind) {
    case "image": {
      // Derive from baseCost (USD) — formula bucketing keeps tiers
      // stable when category markup changes.
      const usd = model.def.pricing.baseCost
      if (usd <= 0.02) return "low"
      if (usd <= 0.05) return "mid"
      if (usd <= 0.1) return "high"
      return "premium"
    }
    case "video": {
      const usd = model.def.pricing.baseCost
      if (usd <= 0.3) return "low"
      if (usd <= 0.7) return "mid"
      if (usd <= 1.2) return "high"
      return "premium"
    }
    case "llm": {
      // Bucket on provider USD/1M output tokens (output dominates spend).
      // Stable across markup changes — was previously keyed on the
      // credit-side rate, which moved with formula tweaks. A known-but-
      // unpriced id (pricing undefined — see ResolvedModel's doc comment)
      // buckets on DEFAULT_PRICING, same fallback convention as
      // `calculateLLMCreditCost` and the HuggingFace route in
      // `route-identity/index.ts`.
      const out = model.pricing?.outputPer1M ?? DEFAULT_PRICING.outputPer1M
      if (out <= 1) return "low"
      if (out <= 10) return "mid"
      if (out <= 30) return "high"
      return "premium"
    }
    case "audio": {
      // Bucket on production USD per billing unit (1k chars or 1 min).
      const usd = model.def.pricing.baseCost
      if (usd <= 0.01) return "low"
      if (usd <= 0.05) return "mid"
      if (usd <= 0.2) return "high"
      return "premium"
    }
    case "voice":
      // Voice metadata isn't priced on its own.
      return "low"
  }
}

/**
 * Display price gauge level (1..5) for a model — the **visual** "price
 * mostly" indicator (Low / Medium / High / Max / Ultra) the pickers and the
 * estimator render as a bar. Distinct from {@link inferCatalogPriceTier}:
 * that one drives 4-value *access* rules (`priceTier:premium`) and must stay a
 * `CatalogPriceTier`; this is cosmetic and free to span 5 bands. Both bucket
 * the same provider USD cost, so they move together by construction.
 */
export function priceTierForModel(model: ResolvedModel): number {
  switch (model.kind) {
    case "image": {
      const usd = model.def.pricing.baseCost
      if (usd <= 0.02) return 1
      if (usd <= 0.05) return 2
      if (usd <= 0.1) return 3
      if (usd <= 0.2) return 4
      return 5
    }
    case "video": {
      const usd = model.def.pricing.baseCost
      if (usd <= 0.3) return 1
      if (usd <= 0.7) return 2
      if (usd <= 1.2) return 3
      if (usd <= 2.5) return 4
      return 5
    }
    case "llm": {
      // Same DEFAULT_PRICING fallback as inferCatalogPriceTier above.
      const out = model.pricing?.outputPer1M ?? DEFAULT_PRICING.outputPer1M
      if (out <= 1) return 1
      if (out <= 10) return 2
      if (out <= 30) return 3
      if (out <= 75) return 4
      return 5
    }
    case "audio": {
      const usd = model.def.pricing.baseCost
      if (usd <= 0.01) return 1
      if (usd <= 0.05) return 2
      if (usd <= 0.2) return 3
      if (usd <= 0.5) return 4
      return 5
    }
    case "voice":
      return 1
  }
}

function inferTags(model: ResolvedModel): string[] {
  const tags: string[] = [model.kind]
  switch (model.kind) {
    case "image":
      if (model.def.provider) tags.push(model.def.provider)
      if (model.def.capabilities.edit) tags.push("edit")
      if (model.def.capabilities.upscale) tags.push("upscale")
      if (model.def.referenceImages.supported) tags.push("ref-images")
      if (!model.def.agentVisible) tags.push("hidden")
      break
    case "video":
      tags.push(model.def.provider)
      if (model.def.capabilities.audio) tags.push("audio")
      if (model.def.capabilities.subjectReference) tags.push("subject-ref")
      if (model.def.capabilities.imageToVideo) tags.push("i2v")
      if (model.def.capabilities.textToVideo) tags.push("t2v")
      if (!model.def.agentVisible) tags.push("hidden")
      break
    case "llm":
      // Provider inferred from canonical id prefix (anthropic / openai / google).
      if (model.canonicalId.includes("claude")) tags.push("anthropic")
      else if (model.canonicalId.includes("gpt")) tags.push("openai")
      else if (model.canonicalId.includes("gemini")) tags.push("google")
      break
    case "audio":
      tags.push(model.def.provider)
      // Modality is multi-valued — emit a tag per enabled capability so
      // access rules can target `s2s` / `tts` / `stt` independently.
      if (model.def.capabilities.tts) tags.push("tts")
      if (model.def.capabilities.stt) tags.push("stt")
      if (model.def.capabilities.s2s) tags.push("s2s")
      for (const lang of model.def.capabilities.languages) {
        tags.push(`lang:${lang}`)
      }
      if (model.def.capabilities.voiceCloning) tags.push("voice-cloning")
      if (model.def.capabilities.streaming) tags.push("streaming")
      if (model.def.capabilities.diarization) tags.push("diarization")
      if (model.def.capabilities.timestamps) tags.push("timestamps")
      if (!model.def.agentVisible) tags.push("hidden")
      break
    case "voice": {
      // "voice" is already pushed via `model.kind`. Tag the engine provider
      // and its modality (s2s engines vs sequential tts) so voice access
      // rules can target the same `s2s`/`tts` vocabulary as audio models.
      tags.push(model.voice.provider)
      const s2sVoice =
        model.voice.provider === "openai-realtime" ||
        model.voice.provider === "gemini-live"
      tags.push(s2sVoice ? "s2s" : "tts")
      tags.push(`gender:${model.voice.gender}`)
      tags.push(`lang:${model.voice.primaryLanguage}`)
      break
    }
  }
  return tags
}

function inferLifecycle(model: ResolvedModel): Lifecycle {
  // Image / video catalogs use `agentVisible: false` to mark legacy /
  // less-used entries — treat those as "deprecated" for rule purposes.
  if (model.kind === "image" && !model.def.agentVisible) return "deprecated"
  if (model.kind === "video" && !model.def.agentVisible) return "deprecated"
  return "stable"
}

/**
 * Compose the curation portion of enrichment (everything except actions).
 * Internal — `getEnrichment` is the public entry that adds actions.
 */
function getCurationEnrichment(model: ResolvedModel): ExplicitEnrichment {
  const explicit = EXPLICIT_ENRICHMENT[model.id]
  if (explicit) return explicit
  // For LLM, also try the canonical id (e.g., "claude-sonnet-4-5" →
  // "claude-sonnet-4" maps via aliases).
  if (model.kind === "llm" && model.canonicalId !== model.id) {
    const byCanonical = EXPLICIT_ENRICHMENT[model.canonicalId]
    if (byCanonical) return byCanonical
  }
  return {
    catalogPriceTier: inferCatalogPriceTier(model),
    tags: inferTags(model),
    lifecycle: inferLifecycle(model),
  }
}

/**
 * Merge two tag arrays preserving first-occurrence order, deduped.
 * Used to fold action tags into curation tags without duplicating.
 */
function mergeTags(
  curation: readonly string[],
  actions: readonly string[]
): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const t of curation) {
    if (seen.has(t)) continue
    seen.add(t)
    out.push(t)
  }
  for (const t of actions) {
    if (seen.has(t)) continue
    seen.add(t)
    out.push(t)
  }
  return out
}

/**
 * Resolve enrichment for any model. Explicit map wins; heuristic fallback
 * fills the rest. Action tags (`<kind>:<verb>`) are derived from the
 * model's capability fields and merged into `tags`. Always returns a
 * value (never undefined).
 */
export function getEnrichment(model: ResolvedModel): ModelEnrichment {
  const curation = getCurationEnrichment(model)
  const actions = getActions(model)
  return {
    catalogPriceTier: curation.catalogPriceTier,
    tags: mergeTags(curation.tags, actions),
    lifecycle: curation.lifecycle,
    actions,
  }
}

export function modelHasTag(model: ResolvedModel, tag: string): boolean {
  return getEnrichment(model).tags.includes(tag)
}

export function modelHasAction(model: ResolvedModel, action: string): boolean {
  return getEnrichment(model).actions.includes(action)
}

export function modelMatchesCatalogPriceTier(
  model: ResolvedModel,
  tier: CatalogPriceTier
): boolean {
  return getEnrichment(model).catalogPriceTier === tier
}

/**
 * @deprecated Use `modelMatchesCatalogPriceTier`. Kept for back-compat
 * with the v1 evaluator's switch case which still uses the
 * `priceTier` discriminator string. The function itself routes to the
 * canonical name.
 */
export function modelMatchesPriceTier(
  model: ResolvedModel,
  tier: CatalogPriceTier
): boolean {
  return modelMatchesCatalogPriceTier(model, tier)
}

export function modelMatchesKind(
  model: ResolvedModel,
  kind: ModelKind
): boolean {
  return model.kind === kind
}
