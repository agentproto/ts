import { describe, expect, it } from "vitest"
import { readFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import {
  mediaOpenRouterImage,
  mediaOpenRouterVideo,
} from "../generators/media-openrouter.js"
import { runGenerators } from "../runner.js"
import type { GeneratorContext } from "../types.js"

const HERE = dirname(fileURLToPath(import.meta.url))
const SNAPSHOTS_DIR = join(HERE, "..", "..", "snapshots")

/** OFFLINE context - reads the committed snapshots, never the network. */
function offlineCtx(): GeneratorContext {
  return {
    refresh: false,
    async fetchSource(src) {
      return JSON.parse(await readFile(join(SNAPSHOTS_DIR, `${src.id}.json`), "utf8"))
    },
  }
}

const IMAGE_OUTPUT = "packages/model-catalog/src/image/openrouter-pricing.generated.ts"
const VIDEO_OUTPUT = "packages/model-catalog/src/video/openrouter-pricing.generated.ts"
const IMAGE_LEDGER = "packages/catalog-sync/ledger/media-openrouter-image.json"
const VIDEO_LEDGER = "packages/catalog-sync/ledger/media-openrouter-video.json"

describe("image:openrouter generator", () => {
  it("declares the expected metadata", () => {
    expect(mediaOpenRouterImage.name).toBe("image:openrouter")
    expect(mediaOpenRouterImage.modality).toBe("image")
    expect(mediaOpenRouterImage.sources[0]?.id).toBe("media-openrouter-image")
    expect(mediaOpenRouterImage.sources[0]?.url).toContain("output_modalities=image")
  })

  it("emits the pricing file and its fetchedAt ledger", async () => {
    const files = await mediaOpenRouterImage.generate(offlineCtx())
    expect(Object.keys(files).sort()).toEqual([IMAGE_LEDGER, IMAGE_OUTPUT].sort())
  })

  it("records per-token prices without inventing a per-image price", async () => {
    const files = await mediaOpenRouterImage.generate(offlineCtx())
    const src = files[IMAGE_OUTPUT]!
    expect(src).toContain("export const OPENROUTER_IMAGE_PRICING: Record<string, MediaPricing>")
    // The two examples from the brief.
    expect(src).toContain(
      '"google/gemini-2.5-flash-image": { unit: "per_token", priceUsd: 0.00003,'
    )
    expect(src).toContain(
      '"openai/gpt-image-1": { unit: "per_token", priceUsd: 0.00004,'
    )
    // Every entry is per_token; no per-image invention.
    expect(src).not.toContain("per_image")
    expect(src).not.toContain("priceUsd: 0,")
  })

  it("is deterministic across two generate calls", async () => {
    const a = await mediaOpenRouterImage.generate(offlineCtx())
    const b = await mediaOpenRouterImage.generate(offlineCtx())
    expect(a).toEqual(b)
  })

  it("matches the runner's offline output (write=false)", async () => {
    const direct = await mediaOpenRouterImage.generate(offlineCtx())
    const { files } = await runGenerators([mediaOpenRouterImage], {
      refresh: false,
      write: false,
    })
    expect(files).toEqual(direct)
  })
})

describe("video:openrouter generator", () => {
  it("declares the expected metadata", () => {
    expect(mediaOpenRouterVideo.name).toBe("video:openrouter")
    expect(mediaOpenRouterVideo.modality).toBe("video")
    expect(mediaOpenRouterVideo.sources[0]?.url).toContain("output_modalities=video")
  })

  it("skips zero-priced routes instead of emitting 0", async () => {
    const files = await mediaOpenRouterVideo.generate(offlineCtx())
    const src = files[VIDEO_OUTPUT]!
    expect(src).toContain("export const OPENROUTER_VIDEO_PRICING: Record<string, MediaPricing>")
    expect(src).toContain("= {\n}")
    expect(src).not.toContain("priceUsd: 0")
  })
})

describe("openrouter media fetchedAt is per route", () => {
  it("restamps only the route whose price moved", async () => {
    const snapshot = JSON.parse(
      await readFile(join(SNAPSHOTS_DIR, "media-openrouter-image.json"), "utf8")
    ) as { data: Array<{ id: string; pricing?: Record<string, string> }> }
    const routes = snapshot.data.filter(m => Number(m.pricing?.image_output) > 0)
    expect(routes.length).toBeGreaterThan(1)
    const moved = routes[0]!
    moved.pricing!.image_output = String(Number(moved.pricing!.image_output) * 2)

    const committed = JSON.parse(
      await readFile(join(HERE, "..", "..", "ledger", "media-openrouter-image.json"), "utf8")
    ) as Record<string, { hash: string; fetchedAt: string }>
    const files = await mediaOpenRouterImage.generate({
      refresh: false,
      fetchSource: async () => snapshot,
    })
    const next = JSON.parse(files[IMAGE_LEDGER]!) as Record<
      string,
      { hash: string; fetchedAt: string }
    >

    expect(next[moved.id]!.hash).not.toBe(committed[moved.id]!.hash)
    for (const route of routes.slice(1)) {
      expect(next[route.id]).toEqual(committed[route.id])
    }
  })
})
