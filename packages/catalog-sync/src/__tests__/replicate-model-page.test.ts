import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import {
  parseReplicateModelPage,
  selectReplicatePrice,
} from "../sources/replicate-model-page.mjs"

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures")
// Real public model pages fetched anonymously ONCE (no token):
//   flux-schnell - per-unit billingConfig tier (per thousand output images)
//   rembg        - hardware-billed (billingConfig null, top-level per second)
const FLUX_SCHNELL = readFileSync(join(FIXTURES, "replicate-flux-schnell.html"), "utf8")
const REMBG = readFileSync(join(FIXTURES, "replicate-rembg.html"), "utf8")

describe("parseReplicateModelPage - per-unit model (flux-schnell)", () => {
  const page = parseReplicateModelPage(FLUX_SCHNELL)

  it("reads the embedded model identity and hardware", () => {
    expect(page.owner).toBe("black-forest-labs")
    expect(page.name).toBe("flux-schnell")
    expect(page.hardware).toBe("H100")
  })

  it("normalizes a per-thousand tier to a per-image unit price", () => {
    expect(page.tierPrices).toHaveLength(1)
    expect(page.tierPrices[0]).toMatchObject({
      metric: "image_output_count",
      unit: "per_image",
      priceUsd: 0.003,
      title: "per thousand output images",
    })
  })

  it("also exposes the top-level hardware price and p50", () => {
    expect(page.hardwarePrice).toMatchObject({ amount: 0.001525, unit: "per_second" })
    expect(page.p50PriceUsd).toBe(0.0048)
  })

  it("selects the per-unit tier over the hardware fallback", () => {
    expect(selectReplicatePrice(page)).toMatchObject({
      unit: "per_image",
      priceUsd: 0.003,
      metric: "image_output_count",
    })
  })
})

describe("parseReplicateModelPage - hardware-billed model (rembg)", () => {
  const page = parseReplicateModelPage(REMBG)

  it("handles a null billingConfig without inventing a tier", () => {
    expect(page.billingConfig).toBeNull()
    expect(page.tierPrices).toEqual([])
  })

  it("reads the top-level per-second price and p50", () => {
    expect(page.hardwarePrice).toMatchObject({ amount: 0.000975, unit: "per_second" })
    expect(page.p50PriceUsd).toBe(0.0039)
  })

  it("falls back to the per-second hardware rate", () => {
    expect(selectReplicatePrice(page)).toMatchObject({
      unit: "per_second",
      priceUsd: 0.000975,
      metric: "hardware",
    })
  })
})

describe("parseReplicateModelPage - page shape changes fail loudly", () => {
  it("throws when no embedded billing JSON is present", () => {
    expect(() => parseReplicateModelPage("<html><body>redesigned</body></html>")).toThrow(
      /no embedded model JSON with billing data found/
    )
  })

  it("throws when the embedded payload has neither a tier nor a top-level price", () => {
    const html = `<script type="application/json">${JSON.stringify({
      model: { owner: "acme", name: "mystery" },
      billingConfig: null,
    })}</script>`
    expect(() => parseReplicateModelPage(html)).toThrow(
      /neither a top-level price nor a mappable per-unit tier/
    )
  })
})

describe("selectReplicatePrice - unexpressible unit", () => {
  it("returns null rather than inventing a hardware per-second price for a per-video tier", () => {
    const html = `<script type="application/json">${JSON.stringify({
      model: { owner: "acme", name: "per-video" },
      billingConfig: {
        current_tiers: [
          {
            criteria: [],
            prices: [
              {
                metric: "video_output_count",
                price: "$0.50",
                title: "per output video",
                type: "per-unit",
              },
            ],
          },
        ],
      },
      price: "$0.001525 per second",
    })}</script>`
    const page = parseReplicateModelPage(html)
    expect(page.tierPrices).toEqual([])
    expect(page.hardwarePrice).toMatchObject({ unit: "per_second" })
    expect(selectReplicatePrice(page)).toBeNull()
  })
})

describe("selectReplicatePrice - multiple tiers", () => {
  function pageWithTiers(tiers: Array<{ price: string; criteria?: unknown[] }>) {
    return parseReplicateModelPage(
      `<script type="application/json">${JSON.stringify({
        model: { owner: "acme", name: "tiered" },
        billingConfig: {
          current_tiers: tiers.map(t => ({
            criteria: t.criteria ?? [],
            prices: [
              {
                metric: "image_output_count",
                price: t.price,
                title: "per output image",
                type: "per-unit",
              },
            ],
          })),
        },
      })}</script>`
    )
  }

  it("returns null instead of silently taking the first tier when prices differ", () => {
    const page = pageWithTiers([
      { price: "$0.04", criteria: [{ name: "resolution", value: "1K" }] },
      { price: "$0.24", criteria: [{ name: "resolution", value: "4K" }] },
    ])
    expect(page.tierPrices).toHaveLength(2)
    expect(selectReplicatePrice(page)).toBeNull()
  })

  it("still selects the price when every tier agrees", () => {
    const page = pageWithTiers([
      { price: "$0.04", criteria: [{ name: "resolution", value: "1K" }] },
      { price: "$0.04", criteria: [{ name: "resolution", value: "2K" }] },
    ])
    expect(selectReplicatePrice(page)).toMatchObject({ unit: "per_image", priceUsd: 0.04 })
  })
})
