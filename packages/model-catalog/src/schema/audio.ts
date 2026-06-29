import { z } from "zod"
import { baseEntryShape } from "./base.js"

// Single source of truth for audio model capabilities — mirrors (and is
// re-used by) the runtime `AudioModelDefinition` in `audio/catalog.ts`.
// Modality is multi-valued boolean flags (`tts`/`stt`/`s2s`) — a model may
// do more than one; `s2s` is a speech↔speech engine (distinct from a
// tts+llm+stt cascade). Transport (`streaming`) is a SEPARATE axis.
export const AudioCapabilitiesSchema = z.object({
  tts: z.boolean().optional(),
  stt: z.boolean().optional(),
  s2s: z.boolean().optional(),
  languages: z.array(z.string()),
  voiceCloning: z.boolean().optional(),
  streaming: z.boolean().optional(),
  timestamps: z.boolean().optional(),
  diarization: z.boolean().optional(),
  languageDetection: z.boolean().optional(),
})
export type AudioCapabilities = z.infer<typeof AudioCapabilitiesSchema>

export const AudioPricingSchema = z.object({
  billingUnit: z.enum(["per_character", "per_second"]),
  baseCost: z.number().nonnegative(),
  baseCostUnit: z.string().optional(),
  /** @deprecated Derived at call time from `baseCost × category-markup`. */
  creditCost: z.number().nonnegative().optional(),
  /** Strategic per-model override — bypasses the formula. */
  overrideCreditCost: z.number().nonnegative().optional(),
})
export type AudioPricing = z.infer<typeof AudioPricingSchema>

// Voices are NOT per-model metadata — they live in the shared, provider-
// neutral voice catalog (`@agstudio/core/config/voice-catalog.ts`,
// `CatalogVoice`), referenced by id. The old per-entry `voice` placeholder
// (+ its `VoiceMetadataSchema`) was never populated — removed.
export const AudioEntrySchema = z.object({
  ...baseEntryShape,
  kind: z.literal("audio"),
  capabilities: AudioCapabilitiesSchema,
  pricing: AudioPricingSchema,
  supportedLocales: z.array(z.string()).optional(),
})
export type AudioEntry = z.infer<typeof AudioEntrySchema>
