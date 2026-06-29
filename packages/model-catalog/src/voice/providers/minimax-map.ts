/**
 * MiniMax raw → CatalogVoice mapper.
 *
 * Single source of "how a MiniMax `/v1/get_voice` system voice becomes a
 * `CatalogVoice`". Shared by `@agentproto/catalog-sync` (build-time baseline
 * emit) and the runtime live-on-setup path. Pure + deterministic.
 */

import { z } from "zod"

import type { CatalogVoice } from "../../schema/voice.js"

// ── Raw source shape (MiniMax POST /v1/get_voice, voice_type:"system") ────

export const MinimaxSystemVoiceSchema = z
  .object({
    voice_id: z.string(),
    voice_name: z.string(),
    description: z.array(z.string()).default([]),
    created_time: z.string().optional(),
  })
  .passthrough()
export type MinimaxSystemVoice = z.infer<typeof MinimaxSystemVoiceSchema>

export const MinimaxVoicesSnapshotSchema = z
  .object({
    system_voice: z.array(MinimaxSystemVoiceSchema),
    base_resp: z
      .object({
        status_code: z.number(),
        status_msg: z.string(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough()
export type MinimaxVoicesSnapshot = z.infer<typeof MinimaxVoicesSnapshotSchema>

// ── Mapping rules ─────────────────────────────────────────────────────────

const SUPPORTED_LANGUAGES = [
  "en", "fr", "es", "de", "it", "pt", "ja", "ko", "zh",
  "ar", "ru", "tr", "nl", "pl", "sv", "da", "no", "fi",
  "hi", "th", "vi", "id", "ms", "tl", "ro", "hu",
] as const

const LANGUAGE_PREFIX_MAP: Record<string, string> = {
  French: "fr",
  English: "en",
  Spanish: "es",
  German: "de",
  Japanese: "ja",
  Korean: "ko",
  "Chinese (Mandarin)": "zh",
  Portuguese: "pt",
  Italian: "it",
  Arabic: "ar",
  Russian: "ru",
  Turkish: "tr",
  Dutch: "nl",
  Polish: "pl",
  Swedish: "sv",
  Danish: "da",
  Norwegian: "no",
  Finnish: "fi",
  Hindi: "hi",
  Thai: "th",
  Vietnamese: "vi",
  Indonesian: "id",
  Malay: "ms",
  Tagalog: "tl",
  Romanian: "ro",
  Hungarian: "hu",
}

const FEMALE_KEYWORDS = ["female", "woman", "lady", "girl", "heroine", "sweet"]
const MALE_KEYWORDS = ["male", "man", "butler", "gentleman", "narrator", "executive"]

function extractLanguageFromVoiceId(voiceId: string): string {
  for (const [prefix, lang] of Object.entries(LANGUAGE_PREFIX_MAP)) {
    if (voiceId.startsWith(prefix)) return lang
  }
  return "en"
}

function inferGender(voiceId: string): "female" | "male" | "neutral" {
  const lower = voiceId.toLowerCase()
  if (FEMALE_KEYWORDS.some(k => lower.includes(k))) return "female"
  if (MALE_KEYWORDS.some(k => lower.includes(k))) return "male"
  return "neutral"
}

function inferAge(voiceId: string): "child" | "young" | "adult" | "senior" | undefined {
  const lower = voiceId.toLowerCase()
  if (lower.includes("child")) return "child"
  if (lower.includes("girl") || lower.includes("young")) return "young"
  if (lower.includes("senior")) return "senior"
  return "adult"
}

function slugify(voiceId: string): string {
  return voiceId
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
}

/** Map one raw MiniMax system voice to a `CatalogVoice`. */
export function mapMinimaxVoice(raw: MinimaxSystemVoice): CatalogVoice {
  const age = inferAge(raw.voice_id)
  const voice: CatalogVoice = {
    catalogId: `minimax-${slugify(raw.voice_id)}`,
    providerVoiceId: raw.voice_id,
    provider: "minimax",
    label: raw.voice_name,
    description: raw.description[0] ?? raw.voice_name,
    gender: inferGender(raw.voice_id),
    primaryLanguage: extractLanguageFromVoiceId(raw.voice_id),
    supportedLanguages: SUPPORTED_LANGUAGES,
    quality: "premium",
    featured: true,
  }
  if (age !== undefined) voice.age = age
  return voice
}

/** Map a full `/v1/get_voice` snapshot to the baseline voice list. */
export function mapMinimaxVoices(
  snapshot: MinimaxVoicesSnapshot,
): CatalogVoice[] {
  return snapshot.system_voice.map(mapMinimaxVoice)
}
