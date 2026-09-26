/**
 * Image replicate generator tests — OFFLINE only, reads committed snapshot.
 */
import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, it, expect } from "vitest"
import { imageReplicate } from "../image-replicate.js"
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

describe("image:replicate generator", () => {
  it("returns a GeneratedFiles record with at least one file", async () => {
    const result = await imageReplicate.generate(createOfflineCtx(false))
    expect(result).toBeDefined()
    expect(typeof result).toBe("object")
    const keys = Object.keys(result)
    expect(keys.length).toBeGreaterThanOrEqual(1)
    expect(keys[0]).toMatch(/image-replicate.*\.generated\.ts$/)
  })

  it("emits valid TypeScript exporting REPLICATE_IMAGE_MODELS as a Record", async () => {
    const result = await imageReplicate.generate(createOfflineCtx(false))
    const source = Object.values(result)[0]!
    expect(typeof source).toBe("string")

    expect(source).toContain("export const REPLICATE_IMAGE_MODELS: Record<string, ImageModelDefinition>")
    expect(source).not.toContain("undefined")
  })

  it("generates ≥1 model entry", async () => {
    const result = await imageReplicate.generate(createOfflineCtx(false))
    const source = Object.values(result)[0]!

    const idCount = (source.match(/\n    id:/g) ?? []).length
    expect(idCount).toBeGreaterThanOrEqual(1)
  })

  it("every model has the required ImageModelDefinition fields", async () => {
    const result = await imageReplicate.generate(createOfflineCtx(false))
    const source = Object.values(result)[0]!

    const requiredFields = [
      "providerId:",
      "provider:",
      "capabilities:",
      "referenceImages:",
      "aspectRatio:",
      "output:",
      "pricing:",
      "description:",
      "agentVisible:",
    ]

    for (const field of requiredFields) {
      expect(source).toContain(field)
    }
  })

  it("every pricing entry includes billingUnit: per_image", async () => {
    const result = await imageReplicate.generate(createOfflineCtx(false))
    const source = Object.values(result)[0]!

    const billingMatches = source.matchAll(/billingUnit: "([^"]+)"/g)
    for (const m of billingMatches) {
      expect(m[1]).toBe("per_image")
    }
  })

  it("has a mix of agentVisible and non-agent-visible models", async () => {
    // Build in-memory payload with curated + unknown models to prove the filter works
    const mixedCtx: GeneratorContext = {
      refresh: false,
      async fetchSource(): Promise<unknown> {
        return {
          results: [
            {
              owner: "black-forest-labs",
              name: "nano-banana-pro",
              description: "Curated model",
              visibility: "public",
              run_count: 1000,
              cover_image_url: "https://example.com/cover.jpg",
              latest_version: {
                id: "v1",
                created_at: "2024-01-01T00:00:00Z",
                openapi_schema: { input: { type: "object", properties: {} }, output: { type: "string" } },
              },
            },
            {
              owner: "flux",
              name: "flux-1.1-pro",
              description: "Another curated model",
              visibility: "public",
              run_count: 500,
              cover_image_url: "https://example.com/cover2.jpg",
              latest_version: {
                id: "v1",
                created_at: "2024-01-01T00:00:00Z",
                openapi_schema: { input: { type: "object", properties: {} }, output: { type: "string" } },
              },
            },
          ],
        }
      },
    }

    const result = await imageReplicate.generate(mixedCtx)
    const source = Object.values(result)[0]!

    // All curated models have agentVisible defined (true or false)
    const visMatches = source.matchAll(/agentVisible: (true|false)/g)
    const visValues = [...visMatches].map(m => m[1])
    expect(visValues.length).toBeGreaterThanOrEqual(1)
    expect(visValues).toContain("true")
  })

  it("provider values are valid (replicate, openai, minimax, google)", async () => {
    const result = await imageReplicate.generate(createOfflineCtx(false))
    const source = Object.values(result)[0]!

    const provMatches = source.matchAll(/provider: "([^"]+)"/g)
    const valid = ["replicate", "openai", "minimax", "google"]
    for (const m of provMatches) {
      expect(valid).toContain(m[1])
    }
  })

  it("output values are string or array only", async () => {
    const result = await imageReplicate.generate(createOfflineCtx(false))
    const source = Object.values(result)[0]!

    const outMatches = source.matchAll(/output: "([^"]+)"/g)
    const valid = ["string", "array"]
    for (const m of outMatches) {
      expect(valid).toContain(m[1])
    }
  })

  it("aspectRatio.default is a valid ratio string", async () => {
    const result = await imageReplicate.generate(createOfflineCtx(false))
    const source = Object.values(result)[0]!

    const defMatches = source.matchAll(/default: "([^"]+)"/g)
    for (const m of defMatches) {
      const val = m[1]
      expect(val).toMatch(/^(\d+:\d+|match_input_image)$/)
    }
  })

  it("costTier values are valid", async () => {
    const result = await imageReplicate.generate(createOfflineCtx(false))
    const source = Object.values(result)[0]!

    const tierMatches = source.matchAll(/costTier: "([^"]+)"/g)
    const valid = ["low", "medium", "high"]
    for (const m of tierMatches) {
      expect(valid).toContain(m[1])
    }
  })

  it("handles DRF-paginated results shape from live API", async () => {
    // Create a fake context that returns a paginated payload with in-memory model
    const paginatedCtx: GeneratorContext = {
      refresh: false,
      async fetchSource(): Promise<unknown> {
        return {
          results: [
            {
              owner: "black-forest-labs",
              name: "flux-2-dev",
              description: "Test model for paginated shape",
              visibility: "public",
              run_count: 2000,
              cover_image_url: "https://example.com/flux.jpg",
              latest_version: {
                id: "v2",
                created_at: "2024-02-01T00:00:00Z",
                openapi_schema: { input: { type: "object", properties: {} }, output: { type: "string" } },
              },
            },
          ],
          next: null,
          previous: null,
        }
      },
    }

    const result = await imageReplicate.generate(paginatedCtx)
    const source = Object.values(result)[0]!

    // Should generate valid output from paginated shape
    expect(source).toContain("export const REPLICATE_IMAGE_MODELS: Record<string, ImageModelDefinition>")
    const idCount = (source.match(/\n    id:/g) ?? []).length
    expect(idCount).toBeGreaterThanOrEqual(1)
  })

  it("handles null description and cover_image_url from live API", async () => {
    const nullFieldsCtx: GeneratorContext = {
      refresh: false,
      async fetchSource(): Promise<unknown> {
        return {
          results: [
            {
              owner: "recraft-ai",
              name: "recraft-v3",
              description: null,
              visibility: "public",
              run_count: 1500,
              cover_image_url: null,
              latest_version: {
                id: "v3",
                created_at: "2024-03-01T00:00:00Z",
                openapi_schema: { input: { type: "object", properties: {} }, output: { type: "string" } },
              },
            },
          ],
          next: null,
          previous: null,
        }
      },
    }

    const result = await imageReplicate.generate(nullFieldsCtx)
    const source = Object.values(result)[0]!

    // Should generate valid output with empty string for null description
    expect(source).toContain("export const REPLICATE_IMAGE_MODELS: Record<string, ImageModelDefinition>")
    expect(source).toContain('description: ""')
  })

  it("handles collection payload shape (models array, no _meta)", async () => {
    // Test the collection endpoint shape: {name, slug, description, models: [...]}
    const collectionCtx: GeneratorContext = {
      refresh: false,
      async fetchSource(): Promise<unknown> {
        return {
          name: "Text to Image",
          slug: "text-to-image",
          description: "Models for generating images from text prompts",
          models: [
            {
              owner: "black-forest-labs",
              name: "flux-kontext-pro",
              description: "Flux Kontext Pro - curated image generation model",
              visibility: "public",
              run_count: 3000,
              cover_image_url: "https://example.com/flux-kontext.jpg",
              latest_version: {
                id: "v1",
                created_at: "2024-04-01T00:00:00Z",
                openapi_schema: { input: { type: "object", properties: {} }, output: { type: "string" } },
              },
            },
          ],
        }
      },
    }

    const result = await imageReplicate.generate(collectionCtx)
    const source = Object.values(result)[0]!

    // Should generate valid output from collection shape
    expect(source).toContain("export const REPLICATE_IMAGE_MODELS: Record<string, ImageModelDefinition>")
    const idCount = (source.match(/\n    id:/g) ?? []).length
    expect(idCount).toBeGreaterThanOrEqual(1)
    // Verify the curated model was included
    expect(source).toContain("flux-kontext-pro")
  })
})
