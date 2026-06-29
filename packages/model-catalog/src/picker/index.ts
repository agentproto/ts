/**
 * Picker subpath — wire shapes returned by the per-app
 * `GET /models/available` route. Single source of truth shared by:
 *   - the server-side helper (an app-side model-access helper)
 *   - the per-app SDK clients (e.g. an app SDK client)
 *   - the cross-app picker hook (an app picker hook)
 *
 * Without this single source the hook + SDK previously drifted from
 * the API contract and a fetcher in the app silently kept calling
 * with a stale auth pattern after the cookie-auth migration.
 */

import type { AccessDecision } from "../access/index.js"
import type { ModelEnrichment } from "../enrichment/index.js"
import type { ModelKind } from "../schema/index.js"

export interface AvailableModelCapabilities {
  generate?: boolean
  edit?: boolean
  upscale?: boolean
  textToVideo?: boolean
  imageToVideo?: boolean
  audio?: boolean
  subjectReference?: boolean
  tts?: boolean
  stt?: boolean
  s2s?: boolean
}

export interface AvailableModel {
  id: string
  /** Canonical model id (LLM aliases collapse here). */
  canonicalId: string
  kind: ModelKind
  displayName: string
  description: string
  enrichment: ModelEnrichment
  decision: AccessDecision
  capabilities: AvailableModelCapabilities
  /** Recommended pricing display (per provider unit). */
  pricingHint?: string
  /**
   * Audio models only: cost normalized to **per minute of speech**, the
   * intuitive unit for the voice picker. TTS (billed per 1k chars) is
   * converted via an assumed speaking rate; per-minute models pass through.
   */
  voiceHint?: string
  /**
   * Relative price gauge level (1..{@link PRICE_TIER_SLOTS}) from
   * `priceTierForModel` — the visual "price mostly" indicator the picker
   * renders as a segmented bar instead of a raw number. 0 when unknown.
   */
  priceTier?: number
  /** Localized-agnostic tier name for `priceTier` (e.g. `"High"`). */
  priceTierName?: string
}

export interface AvailableConnector {
  id: string
  name: string
  /** Whether the actor's guild/workspace has a connected credential for this provider. */
  byokAvailable: boolean
  models: AvailableModel[]
}

// ── Price-tier gauge ─────────────────────────────────────────────────────────
// A relative, comparative price indicator ("price mostly") — a 1..N level
// (from `priceTierForModel`) shown as a filled/empty bar instead of an exact
// number. This module owns the gauge's shape: slot count, names, rendering.

/** Number of segments in the price gauge. */
export const PRICE_TIER_SLOTS = 5

/**
 * Display names for levels 1..{@link PRICE_TIER_SLOTS}, ascending price. Kept
 * as brand tokens (not localized) so the gauge reads the same everywhere.
 */
export const PRICE_TIER_NAMES = [
  "Low",
  "Medium",
  "High",
  "Max",
  "Ultra",
] as const

/** Name for a gauge level (1-based); empty string when out of range. */
export function priceTierName(level: number): string {
  return PRICE_TIER_NAMES[level - 1] ?? ""
}

/**
 * Unicode price gauge (e.g. `▰▰▱▱▱`) for text-only surfaces (WhatsApp, logs).
 * Rich UIs read {@link AvailableModel.priceTier} and render styled segments.
 */
export function priceTierBar(level: number, slots = PRICE_TIER_SLOTS): string {
  const n = Math.max(0, Math.min(level, slots))
  return "▰".repeat(n) + "▱".repeat(slots - n)
}

export interface AvailableModelsActor {
  appId: string
  userId: string
  tier?: string
  guildId?: string
}

export interface AvailableModelsResponse {
  success: true
  actor: AvailableModelsActor
  connectors: AvailableConnector[]
}

export interface ListAvailableModelsParams {
  /** Restrict to one or more kinds. Empty = all kinds. */
  kind?: ModelKind | ModelKind[]
  /** Guild scope — joins guild-level connectors for BYOK badges. */
  guildId?: string
  /** Include rules-blocked models (decision.allowed=false). Default true. */
  includeBlocked?: boolean
  /** Include catalog entries with agentVisible=false. Default false. */
  includeHidden?: boolean
  /**
   * Curation surface-profile id (`voice-s2s`, `images`, …) the app exposes.
   * Resolved server-side via `getSurfaceProfile`. Omitted = full catalog.
   */
  surface?: string
}
