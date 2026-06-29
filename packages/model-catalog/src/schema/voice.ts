import { z } from "zod"

/**
 * TTS / realtime providers a catalog voice routes to. Each voice belongs
 * to exactly one — the voice service picks the right adapter on dispatch.
 *
 *   - `elevenlabs`      — HTTP TTS streaming (sequential engine)
 *   - `minimax`         — HTTP TTS streaming (sequential engine)
 *   - `openai-realtime` — bidirectional realtime WS (s2s engine). Voice id
 *     is the OpenAI voice name (`alloy`, `marin`, …).
 *   - `gemini-live`     — Google Live API (s2s engine). Voice id is the
 *     named speaker (`Aoede`, `Charon`, …).
 *
 * Note: these are the voice-ENGINE provider tags, distinct from the
 * company provider tags audio MODELS carry (`google`/`openai`). A voice's
 * `gemini-live` ↔ the audio model `google/gemini-live` are the same engine.
 */
export const CatalogVoiceProviderSchema = z.enum([
  "minimax",
  "elevenlabs",
  "openai-realtime",
  "gemini-live",
])
export type CatalogVoiceProvider = z.infer<typeof CatalogVoiceProviderSchema>

/**
 * A curated, provider-neutral voice. Carries both the selection metadata
 * the picker shows (label, description, featured, samplePath) and the
 * provider-native descriptors an adapter may surface (age, quality) — one
 * entry serves both the UI and the execution adapter.
 *
 * `catalogId` is the stable provider-native slug saved on
 * `operator.voiceId` rows; renaming the `label` is pure UX and never
 * orphans a saved reference.
 */
export const CatalogVoiceSchema = z.object({
  /** Stable provider-native slug (kept across renames). */
  catalogId: z.string(),
  /** Native provider id: "French_FemaleAnchor", "alloy", "Aoede", … */
  providerVoiceId: z.string(),
  provider: CatalogVoiceProviderSchema,
  /** User-facing natural name: "Élise", "Camille", … */
  label: z.string(),
  description: z.string(),
  gender: z.enum(["female", "male", "neutral"]),
  /** Best language: "fr", "en", … */
  primaryLanguage: z.string(),
  /** Every language the voice can speak. */
  supportedLanguages: z.array(z.string()).readonly(),
  /** Storage path for an audio sample, when one exists. */
  samplePath: z.string().optional(),
  /**
   * Legacy / alternate ids that also resolve to this voice (e.g. the old
   * an app-side alias a renamed voice used to carry). Keeps persisted
   * `operator.voiceId` rows + saved references working across renames.
   */
  aliases: z.array(z.string()).readonly().optional(),
  /** Provider-native age bucket (surfaced by some adapters). */
  age: z.enum(["child", "young", "adult", "senior"]).optional(),
  /** Provider-native quality descriptor ("premium", "standard", …). */
  quality: z.string().optional(),
  /** Show in the voice-picker UI. */
  featured: z.boolean().optional(),
})
export type CatalogVoice = z.infer<typeof CatalogVoiceSchema>
