/**
 * Consumer catalog overlays.
 *
 * The OSS core ships only generated, provider-native data. Anything
 * app-specific — legacy alias slugs persisted in an app's DB (e.g. a product's
 * legacy voice ids), a private fine-tune, a renamed model — is registered
 * by the consumer at boot as an **overlay**, never patched into the core data.
 *
 *   import { registerCatalogOverlay } from "@agentproto/model-catalog/overlay"
 *   registerCatalogOverlay({
 *     aliases: { "legacy-voice-1": "minimax-french-female-anchor" },
 *     image: { "my-finetune": { …ImageModelDefinition } },
 *   })
 *
 * The registry (`getModel` / `resolveAlias` / `listModels`) consults the merged
 * overlay first, then falls through to the generated catalogs. Registration is
 * additive and idempotent-by-key (a later overlay overrides an earlier one for
 * the same id). `clearCatalogOverlays()` resets — used by tests.
 */

import type { LLMPricing } from "../llm/index.js"
import type { ImageModelDefinition } from "../image/index.js"
import type { VideoModelDefinition } from "../video/index.js"
import type { AudioModelDefinition } from "../audio/index.js"
import type { CatalogVoice } from "../voice/index.js"

export interface CatalogOverlay {
  /**
   * Extra alias → canonical-id mappings, any kind. Resolution is followed
   * (chains collapse), so `{ "legacy-voice-1": "minimax-…" }` makes `getModel`,
   * `resolveAlias`, and `isAgentVisible` all treat `legacy-voice-1` as the minimax
   * voice. The target should be a real id in the core catalog or this overlay.
   */
  aliases?: Record<string, string>
  /** Extra or overriding LLM pricing entries, keyed by model id. */
  llm?: Record<string, LLMPricing>
  /** Extra or overriding image model entries, keyed by model id. */
  image?: Record<string, ImageModelDefinition>
  /** Extra or overriding video model entries, keyed by model id. */
  video?: Record<string, VideoModelDefinition>
  /** Extra or overriding audio model entries, keyed by model id. */
  audio?: Record<string, AudioModelDefinition>
  /** Extra voices (matched by catalogId / providerVoiceId / their aliases). */
  voice?: CatalogVoice[]
}

/** The merged, registered overlay state. Same shape as a single overlay but
 *  with all registrations folded in (last-write-wins per key). */
export interface MergedOverlay {
  aliases: Record<string, string>
  llm: Record<string, LLMPricing>
  image: Record<string, ImageModelDefinition>
  video: Record<string, VideoModelDefinition>
  audio: Record<string, AudioModelDefinition>
  voice: CatalogVoice[]
}

function emptyMerged(): MergedOverlay {
  return { aliases: {}, llm: {}, image: {}, video: {}, audio: {}, voice: [] }
}

let MERGED: MergedOverlay = emptyMerged()

/** Register a consumer overlay. Folds into the merged state; later
 *  registrations override earlier ones for the same id. */
export function registerCatalogOverlay(overlay: CatalogOverlay): void {
  if (overlay.aliases) Object.assign(MERGED.aliases, overlay.aliases)
  if (overlay.llm) Object.assign(MERGED.llm, overlay.llm)
  if (overlay.image) Object.assign(MERGED.image, overlay.image)
  if (overlay.video) Object.assign(MERGED.video, overlay.video)
  if (overlay.audio) Object.assign(MERGED.audio, overlay.audio)
  if (overlay.voice) {
    // Replace-by-catalogId so re-registering a voice overrides cleanly.
    const byId = new Map(MERGED.voice.map(v => [v.catalogId, v]))
    for (const v of overlay.voice) byId.set(v.catalogId, v)
    MERGED.voice = [...byId.values()]
  }
}

/** The current merged overlay. Read-only snapshot for the registry. */
export function getMergedOverlay(): MergedOverlay {
  return MERGED
}

/** Reset all overlays (tests / re-init). */
export function clearCatalogOverlays(): void {
  MERGED = emptyMerged()
}
