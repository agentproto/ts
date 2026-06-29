/**
 * Voice minimax generator tests — OFFLINE only, reads committed snapshot.
 */
import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, it, expect } from "vitest"
import { voiceMinimax } from "../voice-minimax.js"
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

describe("voice:minimax generator", () => {
  it("returns a GeneratedFiles record with at least one file", async () => {
    const result = await voiceMinimax.generate(createOfflineCtx(false))
    expect(result).toBeDefined()
    expect(typeof result).toBe("object")
    const keys = Object.keys(result)
    expect(keys.length).toBeGreaterThanOrEqual(1)
    expect(keys[0]).toMatch(/voice-minimax.*\.generated\.ts$/)
  })

  it("emits valid TypeScript exporting MINIMAX_VOICES", async () => {
    const result = await voiceMinimax.generate(createOfflineCtx(false))
    const source = Object.values(result)[0]!
    expect(typeof source).toBe("string")

    expect(source).toContain("export const MINIMAX_VOICES")
    expect(source).toContain("catalogId:")
    expect(source).toContain("providerVoiceId:")
    expect(source).toContain('provider: "minimax"')
    expect(source).not.toContain("undefined")
  })

  it("generates ≥1 voice entry", async () => {
    const result = await voiceMinimax.generate(createOfflineCtx(false))
    const source = Object.values(result)[0]!

    const catalogIdCount = (source.match(/catalogId:/g) ?? []).length
    expect(catalogIdCount).toBeGreaterThanOrEqual(1)
  })

  it("every voice has the required CatalogVoice fields", async () => {
    const result = await voiceMinimax.generate(createOfflineCtx(false))
    const source = Object.values(result)[0]!

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

  it("catalogIds follow the minimax-<slug> convention", async () => {
    const result = await voiceMinimax.generate(createOfflineCtx(false))
    const source = Object.values(result)[0]!

    const matches = source.matchAll(/catalogId: "([^"]+)"/g)
    for (const m of matches) {
      expect(m[1]).toMatch(/^minimax-/)
    }
  })

  it("all genders are valid", async () => {
    const result = await voiceMinimax.generate(createOfflineCtx(false))
    const source = Object.values(result)[0]!

    const genderMatches = source.matchAll(/gender: "([^"]+)"/g)
    const genders = [...genderMatches].map(m => m[1])
    const validGenders = ["female", "male", "neutral"]
    for (const g of genders) {
      expect(validGenders).toContain(g)
    }
  })

  it("providerVoiceId values are escaped properly in generated TS", async () => {
    const result = await voiceMinimax.generate(createOfflineCtx(false))
    const source = Object.values(result)[0]!

    expect(source).toContain("French_FemaleAnchor")
    expect(source).toContain("Chinese (Mandarin)")
  })

  it("supports multiple languages in the snapshot", async () => {
    const result = await voiceMinimax.generate(createOfflineCtx(false))
    const source = Object.values(result)[0]!

    const langMatches = source.matchAll(/primaryLanguage: "([^"]+)"/g)
    const langs = new Set([...langMatches].map(m => m[1]))
    expect(langs.size).toBeGreaterThanOrEqual(3)
    expect(langs.has("fr")).toBe(true)
    expect(langs.has("en")).toBe(true)
  })
})
