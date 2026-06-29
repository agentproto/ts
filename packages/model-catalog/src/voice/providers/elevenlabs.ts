/**
 * ElevenLabs voices — provider-authored source for the unified voice
 * catalog. Each entry is a `CatalogVoice`: identity (`providerVoiceId`)
 * + selection metadata (label, description, gender, languages, featured).
 *
 * ElevenLabs is the one provider fetched LIVE at runtime (`/v1/voices`),
 * so we curate only a featured showcase here; the runtime merge appends
 * the rest of the account's voices on top (deduped on `providerVoiceId`).
 * Hash-style `providerVoiceId`s would slugify to noise, so these carry
 * explicit readable ids. ids are provider-native (e.g. elevenlabs-victoire, the FR default).
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
  "tr",
  "nl",
  "pl",
  "sv",
  "hi",
]

export const ELEVENLABS_VOICES = [
  // ── French (featured) ──
  {
    catalogId: "elevenlabs-victoire",
    providerVoiceId: "O31r762Gb3WFygrEOGh0",
    provider: "elevenlabs",
    label: "Victoire",
    description: "Haute fidélité, voix naturelle premium",
    gender: "female",
    primaryLanguage: "fr",
    supportedLanguages: LANGS,
    age: "young",
    quality: "premium",
    featured: true,
  },
  {
    catalogId: "elevenlabs-victoria",
    providerVoiceId: "WeAAwKYcS06VmXw086yZ",
    provider: "elevenlabs",
    label: "Victoria",
    description: "Chaleureuse et posée, style narration",
    gender: "female",
    primaryLanguage: "fr",
    supportedLanguages: LANGS,
    age: "adult",
    quality: "premium",
    featured: true,
  },
  {
    catalogId: "elevenlabs-nicolas",
    providerVoiceId: "aQROLel5sQbj1vuIVi6B",
    provider: "elevenlabs",
    label: "Nicolas",
    description: "Voix masculine parisienne, style narrateur",
    gender: "male",
    primaryLanguage: "fr",
    supportedLanguages: LANGS,
    age: "adult",
    quality: "premium",
    featured: true,
  },
  // ── English (featured, premade — portable across accounts) ──
  {
    catalogId: "elevenlabs-george",
    providerVoiceId: "JBFqnCBsd6RMkjVDRZzb",
    provider: "elevenlabs",
    label: "George",
    description: "Warm, captivating British storyteller",
    gender: "male",
    primaryLanguage: "en",
    supportedLanguages: LANGS,
    age: "adult",
    quality: "premium",
    featured: true,
  },
  {
    catalogId: "elevenlabs-sarah",
    providerVoiceId: "EXAVITQu4vr4xnSDxMaL",
    provider: "elevenlabs",
    label: "Sarah",
    description: "Mature, reassuring, confident",
    gender: "female",
    primaryLanguage: "en",
    supportedLanguages: LANGS,
    age: "young",
    quality: "premium",
    featured: true,
  },
  {
    catalogId: "elevenlabs-daniel",
    providerVoiceId: "onwK4e9ZLuTAKqWW03F9",
    provider: "elevenlabs",
    label: "Daniel",
    description: "Steady British broadcaster",
    gender: "male",
    primaryLanguage: "en",
    supportedLanguages: LANGS,
    age: "adult",
    quality: "premium",
    featured: true,
  },
  {
    catalogId: "elevenlabs-alice",
    providerVoiceId: "Xb7hH8MSUJpSbSDYk0k2",
    provider: "elevenlabs",
    label: "Alice",
    description: "Clear, engaging British educator",
    gender: "female",
    primaryLanguage: "en",
    supportedLanguages: LANGS,
    age: "adult",
    quality: "premium",
    featured: true,
  },
] as const satisfies readonly CatalogVoice[]
