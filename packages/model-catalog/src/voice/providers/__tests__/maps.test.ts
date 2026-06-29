import { describe, expect, it } from "vitest"

import type { CatalogVoice } from "../../../schema/voice.js"
import {
  ElevenLabsVoicesSnapshotSchema,
  mapElevenLabsVoices,
} from "../elevenlabs-map.js"
import {
  MinimaxVoicesSnapshotSchema,
  mapMinimaxVoices,
} from "../minimax-map.js"

/** First mapped voice, asserted present (narrows away the indexed-access undefined). */
function first(voices: CatalogVoice[]): CatalogVoice {
  const v = voices[0]
  if (!v) throw new Error("expected at least one mapped voice")
  return v
}

describe("mapElevenLabsVoices", () => {
  it("maps a raw /v1/voices entry to a CatalogVoice", () => {
    const v = first(
      mapElevenLabsVoices({
        voices: [
          {
            voice_id: "O31r762Gb3WFygrEOGh0",
            name: "Victoire",
            description: "Premium FR voice",
            labels: { gender: "female", age: "young", accent: "french" },
            preview_url: "https://example.com/v.mp3",
          },
        ],
      }),
    )
    expect(v).toMatchObject({
      catalogId: "elevenlabs-victoire",
      providerVoiceId: "O31r762Gb3WFygrEOGh0",
      provider: "elevenlabs",
      label: "Victoire",
      gender: "female",
      primaryLanguage: "fr",
      age: "young",
      featured: true, // in FEATURED_VOICE_IDS
      samplePath: "https://example.com/v.mp3",
    })
  })

  it("defaults description to label and drops samplePath when absent", () => {
    const v = first(
      mapElevenLabsVoices({
        voices: [
          { voice_id: "x", name: "Foo Bar", labels: {}, description: null, preview_url: null },
        ],
      }),
    )
    expect(v.catalogId).toBe("elevenlabs-foo-bar")
    expect(v.description).toBe("Foo Bar")
    expect(v.primaryLanguage).toBe("en")
    expect(v.featured).toBe(false)
    expect(v.samplePath).toBeUndefined()
  })

  it("tolerates extra fields and a missing labels object", () => {
    const parsed = ElevenLabsVoicesSnapshotSchema.parse({
      voices: [{ voice_id: "y", name: "Y", category: "premade", extra: 1 }],
    })
    const v = first(mapElevenLabsVoices(parsed))
    expect(v.gender).toBe("neutral")
  })
})

describe("mapMinimaxVoices", () => {
  it("maps a system voice, inferring language/gender/age from the id", () => {
    const v = first(
      mapMinimaxVoices({
        system_voice: [
          {
            voice_id: "French_FemaleAnchor",
            voice_name: "Anchor",
            description: ["A warm female anchor voice"],
            created_time: "2025-01-01",
          },
        ],
      }),
    )
    expect(v).toMatchObject({
      catalogId: "minimax-french-femaleanchor",
      providerVoiceId: "French_FemaleAnchor",
      provider: "minimax",
      label: "Anchor",
      description: "A warm female anchor voice",
      gender: "female",
      primaryLanguage: "fr",
      featured: true,
    })
  })

  it("falls back to en/neutral and label when descriptors are absent", () => {
    const parsed = MinimaxVoicesSnapshotSchema.parse({
      system_voice: [{ voice_id: "Mystery_Tone", voice_name: "Tone", description: [] }],
    })
    const v = first(mapMinimaxVoices(parsed))
    expect(v.primaryLanguage).toBe("en")
    expect(v.gender).toBe("neutral")
    expect(v.description).toBe("Tone")
  })
})
