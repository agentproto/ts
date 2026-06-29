/**
 * Gemini Live voices — provider-authored source for the unified voice
 * catalog. Each entry is a `CatalogVoice`: identity (`providerVoiceId`)
 * + selection metadata (label, description, gender, languages, featured).
 *
 * `catalogId`s are derived (`<provider>-<slug(providerVoiceId)>`) and
 * materialized as literals so the `CatalogVoiceId` union stays
 * autocomplete-able. Legacy `simone-N` slugs are preserved in `aliases`.
 * Authored per-provider; `VOICE_CATALOG` concatenates every provider.
 */

import type { CatalogVoice } from "../../schema/voice.js"

const LANGS = [
  "en",
  "fr",
  "es",
  "de",
  "it",
  "pt",
  "ja",
  "ko",
  "zh",
  "ar",
  "ru",
  "hi",
]

export const GEMINI_LIVE_VOICES = [
  {
    catalogId: "gemini-live-aoede",
    providerVoiceId: "Aoede",
    provider: "gemini-live",
    label: "Aoede",
    description: "Gemini Live — bright, melodic",
    gender: "female",
    primaryLanguage: "en",
    supportedLanguages: LANGS,
    aliases: ["simone-46"],
  },
  {
    catalogId: "gemini-live-charon",
    providerVoiceId: "Charon",
    provider: "gemini-live",
    label: "Charon",
    description: "Gemini Live — deep, measured",
    gender: "male",
    primaryLanguage: "en",
    supportedLanguages: LANGS,
    aliases: ["simone-47"],
  },
  {
    catalogId: "gemini-live-fenrir",
    providerVoiceId: "Fenrir",
    provider: "gemini-live",
    label: "Fenrir",
    description: "Gemini Live — gravelly, intense",
    gender: "male",
    primaryLanguage: "en",
    supportedLanguages: LANGS,
    aliases: ["simone-48"],
  },
  {
    catalogId: "gemini-live-kore",
    providerVoiceId: "Kore",
    provider: "gemini-live",
    label: "Kore",
    description: "Gemini Live — clear, articulate",
    gender: "female",
    primaryLanguage: "en",
    supportedLanguages: LANGS,
    aliases: ["simone-49"],
  },
  {
    catalogId: "gemini-live-puck",
    providerVoiceId: "Puck",
    provider: "gemini-live",
    label: "Puck",
    description: "Gemini Live — playful, energetic",
    gender: "neutral",
    primaryLanguage: "en",
    supportedLanguages: LANGS,
    aliases: ["simone-50"],
  },
] as const satisfies readonly CatalogVoice[]
