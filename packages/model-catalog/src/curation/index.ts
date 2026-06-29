/**
 * Curation — what an app SURFACES from the catalog, distinct from
 * model-access (who MAY use a model: tier/scope policy). Curation is the
 * "feature/provider catalog" layer: an app composes views over the one
 * registry ("all s2s voices from OpenAI OR Google", "images only", …)
 * without touching the underlying data.
 *
 * Two registries, both following the canonical profile-registry shape
 * (`listX()` / `getX(id)` throwing with the known-id list):
 *
 *   1. PROVIDER GROUPS — a company (`openai`) maps to every provider tag
 *      it owns across kinds (`openai` for the LLM/audio company tag,
 *      `openai-realtime` for its voice engine). This is what reconciles
 *      the two provider vocabularies in the registry: audio MODELS are
 *      tagged by company, voices by engine. Curating by group spans both.
 *
 *   2. SURFACE PROFILES — named presets (`voice-s2s`, `images`, …) an app
 *      selects from. Permissive by default (`all`); apps narrow only when
 *      a picker should diverge.
 *
 * Selection precedence (caller's job): per-call arg → per-app/guild
 * config → env → `all` fallback.
 */

import {
  listModels,
  type CatalogKind,
  type ResolvedModel,
} from "../registry/index.js"
import { modelHasTag } from "../enrichment/index.js"
import type { CatalogVoice } from "../schema/voice.js"

// ───────────────────────────────────────────────────────────────────────
// Provider groups — company → provider tags across kinds
// ───────────────────────────────────────────────────────────────────────

export interface ProviderGroup {
  /** Canonical company id, e.g. "openai", "google". */
  id: string
  /** Display label. */
  label: string
  /**
   * Every provider tag this company owns across kinds. Audio/image/LLM use
   * the company tag (`openai`); the voice engine uses its own (`openai-realtime`).
   */
  providers: readonly string[]
}

const PROVIDER_GROUPS: readonly ProviderGroup[] = [
  { id: "openai", label: "OpenAI", providers: ["openai", "openai-realtime"] },
  { id: "google", label: "Google", providers: ["google", "gemini-live"] },
  { id: "anthropic", label: "Anthropic", providers: ["anthropic"] },
  { id: "minimax", label: "MiniMax", providers: ["minimax"] },
  { id: "elevenlabs", label: "ElevenLabs", providers: ["elevenlabs"] },
  { id: "replicate", label: "Replicate", providers: ["replicate"] },
  { id: "deepgram", label: "Deepgram", providers: ["deepgram"] },
  { id: "assemblyai", label: "AssemblyAI", providers: ["assemblyai"] },
]

export function listProviderGroups(): readonly ProviderGroup[] {
  return PROVIDER_GROUPS
}

export function getProviderGroup(id: string): ProviderGroup {
  const group = PROVIDER_GROUPS.find(g => g.id === id)
  if (!group) {
    const known = PROVIDER_GROUPS.map(g => g.id).join(", ")
    throw new Error(`curation: unknown provider group "${id}". Known: ${known}`)
  }
  return group
}

/** The group that owns a raw provider tag, if any. */
export function groupForProvider(
  providerTag: string
): ProviderGroup | undefined {
  return PROVIDER_GROUPS.find(g => g.providers.includes(providerTag))
}

/**
 * Expand a mixed list of provider-group ids and raw provider tags into the
 * flat set of provider tags to match against. A token that is a known
 * group id expands to its members; anything else passes through as a raw
 * tag (so callers can target an engine directly, e.g. `gemini-live`).
 */
export function expandProviders(tokens: readonly string[]): string[] {
  const out = new Set<string>()
  for (const token of tokens) {
    const group = PROVIDER_GROUPS.find(g => g.id === token)
    if (group) {
      for (const p of group.providers) out.add(p)
    } else {
      out.add(token)
    }
  }
  return [...out]
}

// ───────────────────────────────────────────────────────────────────────
// Surface profiles — named views an app surfaces
// ───────────────────────────────────────────────────────────────────────

export interface SurfaceProfile {
  id: string
  description: string
  /** Restrict to these kinds. Undefined/empty = every kind. */
  kinds?: readonly CatalogKind[]
  /**
   * Restrict to these provider GROUP ids or raw provider tags (OR-set).
   * Expanded via `expandProviders`, so `["openai"]` covers both the
   * `openai` company tag and the `openai-realtime` voice engine.
   */
  providers?: readonly string[]
  /** Require all of these capability tags (AND-set): `s2s`, `tts`, `edit`, … */
  capabilities?: readonly string[]
  /** Require all of these arbitrary tags (AND-set). */
  tags?: readonly string[]
}

const SURFACE_PROFILES: readonly SurfaceProfile[] = [
  {
    id: "all",
    description: "Everything the catalog offers — the permissive default",
  },
  {
    id: "text",
    description: "Text models (LLMs) only",
    kinds: ["llm"],
  },
  {
    id: "images",
    description: "Image models only",
    kinds: ["image"],
  },
  {
    id: "video",
    description: "Video models only",
    kinds: ["video"],
  },
  {
    id: "audio",
    description: "Audio models (TTS / STT / s2s) only",
    kinds: ["audio"],
  },
  {
    id: "voice",
    description: "Every curated voice, any provider",
    kinds: ["voice"],
  },
  {
    id: "voice-s2s",
    description:
      "Speech-to-speech voice engines (OpenAI Realtime, Gemini Live)",
    kinds: ["voice"],
    capabilities: ["s2s"],
  },
  {
    id: "voice-tts",
    description: "Sequential TTS voices (MiniMax, ElevenLabs)",
    kinds: ["voice"],
    capabilities: ["tts"],
  },
]

export function listSurfaceProfiles(): readonly SurfaceProfile[] {
  return SURFACE_PROFILES
}

export function getSurfaceProfile(id: string): SurfaceProfile {
  const profile = SURFACE_PROFILES.find(p => p.id === id)
  if (!profile) {
    const known = SURFACE_PROFILES.map(p => p.id).join(", ")
    throw new Error(
      `curation: unknown surface profile "${id}". Known: ${known}`
    )
  }
  return profile
}

// ───────────────────────────────────────────────────────────────────────
// Filters
// ───────────────────────────────────────────────────────────────────────

/**
 * True iff a model passes a surface profile. Provider membership, like
 * capability/tag membership, is checked against the enrichment tag
 * vocabulary (every kind emits its provider as a tag), so this is uniform
 * across kinds and naturally spans the company/engine provider split.
 */
export function modelMatchesProfile(
  model: ResolvedModel,
  profile: SurfaceProfile
): boolean {
  if (profile.kinds && profile.kinds.length > 0) {
    if (!profile.kinds.includes(model.kind)) return false
  }
  if (profile.providers && profile.providers.length > 0) {
    const tags = expandProviders(profile.providers)
    if (!tags.some(tag => modelHasTag(model, tag))) return false
  }
  if (profile.capabilities) {
    if (!profile.capabilities.every(cap => modelHasTag(model, cap)))
      return false
  }
  if (profile.tags) {
    if (!profile.tags.every(tag => modelHasTag(model, tag))) return false
  }
  return true
}

/** Filter a model list down to what a surface profile exposes. */
export function applyProfile(
  models: ResolvedModel[],
  profile: SurfaceProfile
): ResolvedModel[] {
  return models.filter(model => modelMatchesProfile(model, profile))
}

/**
 * The catalog as a surface profile exposes it — `applyProfile` over the
 * full registry. The composable entry point for "show me this view".
 */
export function listSurfaced(profile: SurfaceProfile): ResolvedModel[] {
  return applyProfile(listModels(), profile)
}

/**
 * Voice-list curation. The merged voice catalog (curated + live
 * ElevenLabs) is `CatalogVoice[]`, not `ResolvedModel[]`, so it gets its
 * own provider filter — same group-expansion semantics. Only the provider
 * facet of a profile applies to a raw voice list (kind is implicitly
 * voice; capability/tag live on the registry projection).
 */
export function filterVoicesByProviders(
  voices: CatalogVoice[],
  providerTokens: readonly string[]
): CatalogVoice[] {
  if (providerTokens.length === 0) return voices
  const tags = new Set(expandProviders(providerTokens))
  return voices.filter(v => tags.has(v.provider))
}
