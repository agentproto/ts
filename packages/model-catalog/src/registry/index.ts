/**
 * Cross-kind registry. Resolves a model id against every catalog (LLM,
 * image, video, audio) and returns a discriminated `ResolvedModel`.
 *
 * v1 returns the legacy per-kind data shapes verbatim — image/video keep
 * `*ModelDefinition`, LLM keeps `LLMPricing`, audio surfaces voices.
 * Callers (cost dispatcher, access evaluator) match on `.kind` and dig
 * into the per-kind payload as needed.
 */

import {
  LLM_PRICING_CATALOG,
  resolveAlias as resolveLlmAlias,
  resolvePricing,
  type LLMPricing,
} from "../llm/index.js"
import {
  IMAGE_MODEL_CATALOG,
  type ImageModelDefinition,
} from "../image/index.js"
import {
  VIDEO_MODEL_CATALOG,
  type VideoModelDefinition,
} from "../video/index.js"
import {
  AUDIO_MODEL_CATALOG,
  type AudioModelDefinition,
} from "../audio/index.js"
import { VOICE_CATALOG, type CatalogVoice } from "../voice/index.js"
import { modelHasTag } from "../enrichment/index.js"

/**
 * `audio` resolves to either an audio MODEL (priced TTS/STT) or a
 * voice (downstream metadata). Most call sites care about the model
 * (pricing, capabilities); a few (voice pickers) want the voice. They
 * share the resolver but discriminate on the inner payload.
 */
export type ResolvedModel =
  | { kind: "llm"; id: string; canonicalId: string; pricing: LLMPricing }
  | { kind: "image"; id: string; def: ImageModelDefinition }
  | { kind: "video"; id: string; def: VideoModelDefinition }
  | { kind: "audio"; id: string; def: AudioModelDefinition }
  | { kind: "voice"; id: string; voice: CatalogVoice }

/**
 * Every kind the registry can resolve. Broader than the catalog
 * `ModelKind` (llm/image/video/audio) because voices are a first-class
 * registry kind but not a priced model family. Derived from
 * `ResolvedModel` so it can never drift.
 */
export type CatalogKind = ResolvedModel["kind"]

// Voices resolve by canonical id ("minimax-french-female-anchor"), native
// provider id ("French_FemaleAnchor"), or legacy alias ("simone-2") — index
// all three so new slugs, native ids, and persisted operator rows all hit.
const VOICE_INDEX: Map<string, CatalogVoice> = new Map([
  ...VOICE_CATALOG.map(v => [v.providerVoiceId, v] as const),
  ...VOICE_CATALOG.map(v => [v.catalogId, v] as const),
  ...VOICE_CATALOG.flatMap((v: CatalogVoice) =>
    (v.aliases ?? []).map(a => [a, v] as const)
  ),
])

/**
 * Resolves a model id across every catalog.
 *
 * Lookup order: image → video → audio → LLM (last because LLM has the
 * partial-prefix fallback that can match other strings if probed first).
 *
 * Returns `undefined` for unknown ids — callers decide whether to throw
 * or fall back. LLM uses fallback pricing inside its own dispatcher
 * (preserves existing behavior at the orchestrator).
 */
export function getModel(id: string): ResolvedModel | undefined {
  const imageDef = IMAGE_MODEL_CATALOG[id]
  if (imageDef) return { kind: "image", id, def: imageDef }

  const videoDef = VIDEO_MODEL_CATALOG[id]
  if (videoDef) return { kind: "video", id, def: videoDef }

  // Audio MODEL (priced TTS/STT) — checked before voice lookup so an
  // id that exists in both maps lands on the priced entry.
  const audioDef = AUDIO_MODEL_CATALOG[id]
  if (audioDef) return { kind: "audio", id, def: audioDef }

  const voice = VOICE_INDEX.get(id)
  if (voice) return { kind: "voice", id, voice }

  const llmPricing = resolvePricing(id)
  if (llmPricing) {
    const canonicalId = resolveLlmAlias(id)
    return { kind: "llm", id, canonicalId, pricing: llmPricing }
  }

  return undefined
}

/**
 * Returns true iff the id is exposed to agents.
 *
 * - LLM: every entry in `LLM_PRICING_CATALOG` is considered visible
 *   (legacy convention; refine in v2 with per-entry `agentVisible`).
 * - Image / Video: respects the `agentVisible` flag.
 * - Audio voices: all voices are visible (catalog itself is curated).
 */
export function isAgentVisible(id: string): boolean {
  const m = getModel(id)
  if (!m) return false
  switch (m.kind) {
    case "image":
      return m.def.agentVisible
    case "video":
      return m.def.agentVisible
    case "audio":
      return m.def.agentVisible
    case "llm":
      return (
        id in LLM_PRICING_CATALOG || resolveLlmAlias(id) in LLM_PRICING_CATALOG
      )
    case "voice":
      return true
  }
}

export interface ListModelsFilter {
  kind?: CatalogKind
  /** Single provider (back-compat). Folded into `providers` internally. */
  provider?: string
  /** Provider OR-set — a model matches if its provider is any of these. */
  providers?: string[]
  /**
   * Capability tags a model must carry (ALL of them). Capabilities are
   * emitted as tags by enrichment — audio `tts`/`stt`/`s2s`, image
   * `edit`/`upscale`, video `i2v`/`t2v` — so this filters on the same
   * vocabulary `listModels({capabilities:["s2s"]})` would expect.
   */
  capabilities?: string[]
  /** Arbitrary tags a model must carry (ALL of them). */
  tags?: string[]
  agentVisibleOnly?: boolean
}

/**
 * Cross-kind listing. Useful for catalog browsers and capability search.
 * Returns `ResolvedModel[]` (discriminated by kind).
 *
 * Provider is an OR-set (`providers` ∪ the singular `provider`); capability
 * and tag filters are AND-sets (a model must carry every listed value).
 * Composed: `listModels({ kind:"audio", capabilities:["s2s"],
 * providers:["gemini-live","openai-realtime"] })` → all s2s models from
 * Gemini OR OpenAI.
 */
export function listModels(filter: ListModelsFilter = {}): ResolvedModel[] {
  const providerSet =
    filter.provider || filter.providers
      ? new Set([
          ...(filter.provider ? [filter.provider] : []),
          ...(filter.providers ?? []),
        ])
      : undefined
  const providerMatches = (provider: string | undefined): boolean =>
    !providerSet || (provider !== undefined && providerSet.has(provider))

  const out: ResolvedModel[] = []

  if (!filter.kind || filter.kind === "image") {
    for (const [id, def] of Object.entries(IMAGE_MODEL_CATALOG)) {
      if (!providerMatches(def.provider)) continue
      if (filter.agentVisibleOnly && !def.agentVisible) continue
      out.push({ kind: "image", id, def })
    }
  }
  if (!filter.kind || filter.kind === "video") {
    for (const [id, def] of Object.entries(VIDEO_MODEL_CATALOG)) {
      if (!providerMatches(def.provider)) continue
      if (filter.agentVisibleOnly && !def.agentVisible) continue
      out.push({ kind: "video", id, def })
    }
  }
  if (!filter.kind || filter.kind === "audio") {
    for (const [id, def] of Object.entries(AUDIO_MODEL_CATALOG)) {
      if (!providerMatches(def.provider)) continue
      if (filter.agentVisibleOnly && !def.agentVisible) continue
      out.push({ kind: "audio", id, def })
    }
  }
  if (!filter.kind || filter.kind === "voice") {
    for (const v of VOICE_CATALOG) {
      if (!providerMatches(v.provider)) continue
      out.push({ kind: "voice", id: v.catalogId, voice: v })
    }
  }
  if (!filter.kind || filter.kind === "llm") {
    for (const [id, pricing] of Object.entries(LLM_PRICING_CATALOG)) {
      if (!providerMatches(pricing.provider)) continue
      out.push({ kind: "llm", id, canonicalId: id, pricing })
    }
  }

  // Capability + tag filters are AND-sets, applied over the enrichment tag
  // vocabulary (capabilities are emitted as tags). Skipped entirely when
  // unset so the common path stays allocation-free.
  const required = [...(filter.capabilities ?? []), ...(filter.tags ?? [])]
  if (required.length === 0) return out
  return out.filter(model => required.every(tag => modelHasTag(model, tag)))
}

/**
 * Provider-centric view — every model a provider offers across all kinds
 * (llm / image / video / audio incl. tts/stt/s2s). This is the "provider
 * catalog" (openai, google, anthropic, replicate, openrouter, …): a
 * derived query over the kind-organized catalogs, NOT a parallel store.
 */
export function getModelsByProvider(provider: string): ResolvedModel[] {
  return listModels({ provider })
}

/**
 * Returns the platform a model's adapter is **statically pinned** to,
 * if known. ONLY meaningful for image / video / audio — those adapters
 * are constructed per-platform (Replicate adapter, MiniMax adapter…),
 * so the model's `def.provider` IS the runtime connector.
 *
 * For LLM, returns `undefined` — the runtime connector is determined
 * at call time by `pickLlmConnector(connectors, parseModelId(id).provider)`
 * against the guild's installed connectors, NOT by the model id alone.
 * The same `anthropic/claude-sonnet-4-5` can route through OpenRouter
 * OR direct Anthropic depending on which connectors the guild has
 * installed. Recording call sites MUST pass the actual `connectorUsed`
 * they invoked; do not infer from id.
 *
 * Use case: image/video workflow steps fetch `model.def.provider`
 * directly (no ambiguity). LLM call sites use the runtime resolver.
 */
export function getStaticModelProvider(
  model: ResolvedModel
): string | undefined {
  switch (model.kind) {
    case "image":
    case "video":
    case "audio":
      return model.def.provider
    case "voice":
      return model.voice.provider
    case "llm":
      // Runtime routing — caller knows, we don't.
      return undefined
  }
}

/**
 * Resolves an id to its canonical catalog key across kinds. For ids that
 * have no alias, returns the id unchanged. Used by callers that want to
 * normalize before persisting (e.g., `byok_usage` rows).
 */
export function resolveAlias(id: string): string {
  if (IMAGE_MODEL_CATALOG[id]) return id
  if (VIDEO_MODEL_CATALOG[id]) return id
  if (AUDIO_MODEL_CATALOG[id]) return id
  if (VOICE_INDEX.has(id)) return id
  return resolveLlmAlias(id)
}
