/**
 * ElevenLabs raw → CatalogVoice mapper.
 *
 * The single source of "how an ElevenLabs `/v1/voices` entry becomes a
 * `CatalogVoice`". Used in two places:
 *   - build time, by `@agentproto/catalog-sync` to emit the full baseline
 *     voice list from a pinned snapshot;
 *   - runtime, by the live-on-setup path (`agentproto auth provider set
 *     elevenlabs`) to turn a freshly-fetched account voice library into the
 *     local overlay cache.
 *
 * Pure + deterministic — no network, no fs. The raw schema validates both the
 * pinned snapshot and a live response so a provider shape-change surfaces as a
 * parse error, not silent data loss.
 */

import { z } from "zod"

import type { CatalogVoice } from "../../schema/voice.js"

// ── Raw source shape (ElevenLabs GET /v1/voices) ─────────────────────────

export const ElevenLabsRawVoiceSchema = z
  .object({
    voice_id: z.string(),
    name: z.string(),
    category: z.string().optional(),
    description: z.string().nullable().optional(),
    labels: z.record(z.string(), z.string()).default({}),
    preview_url: z.string().nullable().optional(),
  })
  .passthrough()
export type ElevenLabsRawVoice = z.infer<typeof ElevenLabsRawVoiceSchema>

export const ElevenLabsVoicesSnapshotSchema = z.object({
  voices: z.array(ElevenLabsRawVoiceSchema),
})
export type ElevenLabsVoicesSnapshot = z.infer<
  typeof ElevenLabsVoicesSnapshotSchema
>

// ── Mapping rules ─────────────────────────────────────────────────────────

const SUPPORTED_LANGUAGES = [
  "en", "fr", "es", "de", "it", "pt", "ja", "ko", "zh",
  "ar", "ru", "tr", "nl", "pl", "sv", "hi",
] as const

const ACCENT_TO_LANG: Record<string, string> = {
  french: "fr",
  british: "en",
  american: "en",
  australian: "en",
  indian: "en",
  spanish: "es",
  german: "de",
  italian: "it",
  portuguese: "pt",
  japanese: "ja",
  korean: "ko",
  chinese: "zh",
  mandarin: "zh",
  arabic: "ar",
  russian: "ru",
  turkish: "tr",
  dutch: "nl",
  polish: "pl",
  swedish: "sv",
  hindi: "hi",
}

/** Featured showcase voice ids — surfaced in the picker by default. */
const FEATURED_VOICE_IDS = new Set([
  "O31r762Gb3WFygrEOGh0", // Victoire
  "WeAAwKYcS06VmXw086yZ", // Victoria
  "aQROLel5sQbj1vuIVi6B", // Nicolas
  "JBFqnCBsd6RMkjVDRZzb", // George
  "EXAVITQu4vr4xnSDxMaL", // Sarah
  "onwK4e9ZLuTAKqWW03F9", // Daniel
  "Xb7hH8MSUJpSbSDYk0k2", // Alice
])

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
}

function inferGender(labels: Record<string, string>): "female" | "male" | "neutral" {
  const g = labels.gender?.toLowerCase()
  if (g === "female") return "female"
  if (g === "male") return "male"
  return "neutral"
}

function inferAge(labels: Record<string, string>): "child" | "young" | "adult" | "senior" | undefined {
  const a = labels.age?.toLowerCase()
  if (a === "child") return "child"
  if (a === "young") return "young"
  if (a === "middle_aged" || a === "adult") return "adult"
  if (a === "senior") return "senior"
  return undefined
}

function inferPrimaryLanguage(labels: Record<string, string>): string {
  const accent = labels.accent?.toLowerCase()
  if (accent && ACCENT_TO_LANG[accent]) return ACCENT_TO_LANG[accent]
  return "en"
}

/** Map one raw ElevenLabs voice to a `CatalogVoice`. */
export function mapElevenLabsVoice(raw: ElevenLabsRawVoice): CatalogVoice {
  const labels = raw.labels ?? {}
  const age = inferAge(labels)
  const samplePath = raw.preview_url ?? undefined
  const voice: CatalogVoice = {
    catalogId: `elevenlabs-${slugify(raw.name)}`,
    providerVoiceId: raw.voice_id,
    provider: "elevenlabs",
    label: raw.name,
    description: raw.description ?? raw.name,
    gender: inferGender(labels),
    primaryLanguage: inferPrimaryLanguage(labels),
    supportedLanguages: SUPPORTED_LANGUAGES,
    quality: "premium",
    featured: FEATURED_VOICE_IDS.has(raw.voice_id),
  }
  if (samplePath !== undefined) voice.samplePath = samplePath
  if (age !== undefined) voice.age = age
  return voice
}

/** Map a full `/v1/voices` snapshot to the baseline voice list. */
export function mapElevenLabsVoices(
  snapshot: ElevenLabsVoicesSnapshot,
): CatalogVoice[] {
  return snapshot.voices.map(mapElevenLabsVoice)
}
