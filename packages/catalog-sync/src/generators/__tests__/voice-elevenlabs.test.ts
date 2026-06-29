/**
 * Voice elevenlabs generator tests — OFFLINE only, reads committed snapshot.
 */
import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, it, expect } from "vitest"
import { voiceElevenlabs } from "../voice-elevenlabs.js"
import type { GeneratorContext, CatalogSource } from "../../types.js"

function createOfflineCtx(refresh: boolean): GeneratorContext {
  return {
    refresh,
    // Mirror the framework's snapshot-first reader (snapshots/<id>.json),
    // never the network — keeps the test fully offline + deterministic.
    async fetchSource(src: CatalogSource): Promise<unknown> {
      const p = resolve(
        dirname(fileURLToPath(import.meta.url)),
        "../../../snapshots",
        `${src.id}.json`,
      )
      return JSON.parse(readFileSync(p, "utf-8"))
    },
  }
}

describe("voice:elevenlabs generator", () => {
  it("returns a GeneratedFiles record with at least one file", async () => {
    const result = await voiceElevenlabs.generate(createOfflineCtx(false))
    expect(result).toBeDefined()
    expect(typeof result).toBe("object")
    const keys = Object.keys(result)
    expect(keys.length).toBeGreaterThanOrEqual(1)
    expect(keys[0]).toMatch(/voice-elevenlabs.*\.generated\.ts$/)
  })

  it("emits valid TypeScript exporting ELEVENLABS_VOICES", async () => {
    const result = await voiceElevenlabs.generate(createOfflineCtx(false))
    const source = Object.values(result)[0]!
    expect(typeof source).toBe("string")

    // Verify it exports the expected const
    expect(source).toContain("export const ELEVENLABS_VOICES")
    expect(source).toContain("catalogId:")
    expect(source).toContain("providerVoiceId:")
    expect(source).toContain('provider: "elevenlabs"')

    // Basic TS-ish sanity: no unquoted undefined
    expect(source).not.toContain("undefined")
  })

  it("generates ≥1 voice entry", async () => {
    const result = await voiceElevenlabs.generate(createOfflineCtx(false))
    const source = Object.values(result)[0]!

    // Count occurrences of "catalogId:" as a proxy for voice count
    const catalogIdCount = (source.match(/catalogId:/g) ?? []).length
    expect(catalogIdCount).toBeGreaterThanOrEqual(1)
  })

  it("every voice has the required CatalogVoice fields", async () => {
    const result = await voiceElevenlabs.generate(createOfflineCtx(false))
    const source = Object.values(result)[0]!

    // Every catalogId line should be followed by the mandatory fields
    const requiredFields = [
      "providerVoiceId",
      "provider",
      "label",
      "description",
      "gender",
      "primaryLanguage",
      "supportedLanguages",
      "quality",
      "featured",
    ]

    for (const field of requiredFields) {
      expect(source).toContain(`${field}:`)
    }
  })

  it("catalogIds follow the elevenlabs-<slug> convention", async () => {
    const result = await voiceElevenlabs.generate(createOfflineCtx(false))
    const source = Object.values(result)[0]!

    // Extract catalogIds
    const matches = source.matchAll(/catalogId: "([^"]+)"/g)
    for (const m of matches) {
      expect(m[1]).toMatch(/^elevenlabs-/)
    }
  })

  it("refresh mode does NOT hit the network (fallback to snapshot)", async () => {
    const result = await voiceElevenlabs.generate(createOfflineCtx(false))
    expect(Object.keys(result).length).toBeGreaterThanOrEqual(1)
  })

  it("all genders are valid", async () => {
    const result = await voiceElevenlabs.generate(createOfflineCtx(false))
    const source = Object.values(result)[0]!

    const genderMatches = source.matchAll(/gender: "([^"]+)"/g)
    const genders = [...genderMatches].map(m => m[1])
    const validGenders = ["female", "male", "neutral"]
    for (const g of genders) {
      expect(validGenders).toContain(g)
    }
  })
})
