/**
 * image-replicate generator — reads a curated Replicate image-models
 * snapshot and emits ImageModelDefinition[]-shaped generated TS entries.
 *
 * Mirrors the shape from packages/model-catalog/src/image/catalog.ts exactly.
 * Provider-native ids only; no product-specific aliases.
 */

import type {
  CatalogGenerator,
  CatalogSource,
  GeneratedFiles,
  GeneratorContext,
} from "../types.js"
import { defineGenerator } from "../types.js"

// ── Replicate snapshot shapes ───────────────────────────────────────────

interface ReplicateOpenApiSchema {
  input: { type: string; properties: Record<string, { type: string; items?: { type: string }; format?: string }> }
  output: { type: string; items?: { type: string; format?: string }; format?: string }
}

interface ReplicateLatestVersion {
  id: string
  created_at: string
  openapi_schema: ReplicateOpenApiSchema
}

interface ReplicateModel {
  owner: string
  name: string
  description: string
  visibility: string
  run_count: number
  cover_image_url: string | null
  latest_version: ReplicateLatestVersion
}

interface ReplicateSnapshot {
  _meta: Record<string, unknown>
  models: ReplicateModel[]
}

// ── ImageModelDefinition mirror (from packages/model-catalog/src/image/catalog.ts) ──

interface ImageModelPricing {
  costPerImage: number
  costTier: "low" | "medium" | "high"
  billingUnit: "per_image"
  baseCost: number
  creditCost?: number
  overrideCreditCost?: number
}

interface ImageModelCapabilities {
  generate: boolean
  edit: boolean
  upscale?: boolean
}

interface ImageModelReferenceImages {
  supported: boolean
  fieldName: "image_input" | "input_images" | "input_image" | "none"
  maxCount: number
  singular: boolean
}

interface ImageModelAspectRatio {
  supported: string[]
  default: string
}

interface ImageModelEntry {
  id: string
  name: string
  providerId: string
  provider: string
  capabilities: ImageModelCapabilities
  referenceImages: ImageModelReferenceImages
  aspectRatio: ImageModelAspectRatio
  output: "string" | "array"
  pricing: ImageModelPricing
  description: string
  agentVisible: boolean
  triggerWord?: string
}

// ── Pricing (hand-authored, mirrors model-catalog) ──────────────────────

interface PricingRecord {
  costPerImage: number
  costTier: "low" | "medium" | "high"
  baseCost: number
  creditCost?: number
  overrideCreditCost?: number
}

const PRICING: Record<string, PricingRecord> = {
  "nano-banana-pro": { costPerImage: 0.15, costTier: "high", baseCost: 0.15, creditCost: 10 },
  "nano-banana-2": { costPerImage: 0.06, costTier: "medium", baseCost: 0.06, creditCost: 5 },
  "nano-banana": { costPerImage: 0.04, costTier: "low", baseCost: 0.04, creditCost: 5 },
  "flux-2-dev": { costPerImage: 0.03, costTier: "low", baseCost: 0.03, creditCost: 3 },
  "flux-kontext-pro": { costPerImage: 0.04, costTier: "low", baseCost: 0.04, creditCost: 5 },
  "flux-kontext-max": { costPerImage: 0.08, costTier: "medium", baseCost: 0.08, creditCost: 8 },
  "flux-1.1-pro-ultra": { costPerImage: 0.06, costTier: "medium", baseCost: 0.06, creditCost: 8 },
  "seedream-4": { costPerImage: 0.03, costTier: "low", baseCost: 0.03, creditCost: 3 },
  "recraft-v3": { costPerImage: 0.04, costTier: "low", baseCost: 0.04, creditCost: 5 },
  "image-01": { costPerImage: 0.02, costTier: "low", baseCost: 0.02, creditCost: 2 },
  "gpt-image-1": { costPerImage: 0.04, costTier: "low", baseCost: 0.04, creditCost: 5 },
  "ideogram-v3-turbo": { costPerImage: 0.03, costTier: "low", baseCost: 0.03, creditCost: 4 },
  "flux-1.1-pro": { costPerImage: 0.04, costTier: "low", baseCost: 0.04, creditCost: 5 },
}

// Models visible to agents (the active generation ones)
const AGENT_VISIBLE = new Set([
  "nano-banana-pro",
  "nano-banana-2",
  "nano-banana",
  "flux-2-dev",
  "flux-kontext-pro",
  "flux-kontext-max",
  "flux-1.1-pro-ultra",
  "seedream-4",
  "recraft-v3",
  "image-01",
  "gpt-image-1",
  "ideogram-v3-turbo",
])

const ASPECT_RATIOS_DEFAULT: ImageModelAspectRatio = {
  supported: ["1:1", "9:16", "16:9", "2:3", "3:2", "3:4", "4:3"],
  default: "1:1",
}

const ASPECT_RATIOS_WIDE: ImageModelAspectRatio = {
  supported: ["1:1", "9:16", "16:9", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4"],
  default: "1:1",
}

const ASPECT_RATIOS_ULTRA: ImageModelAspectRatio = {
  supported: ["1:1", "9:16", "16:9", "21:9", "9:21", "3:4", "4:3"],
  default: "1:1",
}

const ASPECT_RATIOS_NBPRO: ImageModelAspectRatio = {
  supported: [
    "1:1", "9:16", "16:9", "2:3", "3:2", "3:4", "4:3",
    "4:5", "5:4", "21:9",
  ],
  default: "match_input_image",
}

const ASPECT_RATIOS_NB2: ImageModelAspectRatio = {
  supported: [
    "1:1", "9:16", "16:9", "2:3", "3:2", "3:4", "4:3",
    "4:5", "5:4",
  ],
  default: "match_input_image",
}

const ASPECT_RATIOS_SQUARE: ImageModelAspectRatio = {
  supported: ["1:1"],
  default: "1:1",
}

interface ModelSpec {
  id: string
  name: string
  capabilities: ImageModelCapabilities
  referenceImages: ImageModelReferenceImages
  aspectRatio: ImageModelAspectRatio
  output: "string" | "array"
  triggerWord?: string
}

const MODEL_SPECS: Record<string, ModelSpec> = {
  "nano-banana-pro": {
    id: "nano-banana-pro",
    name: "Nano Banana Pro",
    capabilities: { generate: true, edit: true },
    referenceImages: { supported: true, fieldName: "image_input", maxCount: 14, singular: false },
    aspectRatio: ASPECT_RATIOS_NBPRO,
    output: "string",
  },
  "nano-banana-2": {
    id: "nano-banana-2",
    name: "Nano Banana 2",
    capabilities: { generate: true, edit: true },
    referenceImages: { supported: true, fieldName: "image_input", maxCount: 4, singular: false },
    aspectRatio: ASPECT_RATIOS_NB2,
    output: "string",
  },
  "nano-banana": {
    id: "nano-banana",
    name: "Nano Banana",
    capabilities: { generate: true, edit: true },
    referenceImages: { supported: true, fieldName: "image_input", maxCount: 4, singular: false },
    aspectRatio: ASPECT_RATIOS_DEFAULT,
    output: "string",
  },
  "flux-2-dev": {
    id: "flux-2-dev",
    name: "Flux 2 Dev",
    capabilities: { generate: true, edit: true },
    referenceImages: { supported: true, fieldName: "input_images", maxCount: 5, singular: false },
    aspectRatio: ASPECT_RATIOS_WIDE,
    output: "string",
  },
  "flux-kontext-pro": {
    id: "flux-kontext-pro",
    name: "Flux Kontext Pro",
    capabilities: { generate: true, edit: true },
    referenceImages: { supported: true, fieldName: "input_image", maxCount: 1, singular: true },
    aspectRatio: ASPECT_RATIOS_DEFAULT,
    output: "string",
  },
  "flux-kontext-max": {
    id: "flux-kontext-max",
    name: "Flux Kontext Max",
    capabilities: { generate: true, edit: true },
    referenceImages: { supported: true, fieldName: "input_image", maxCount: 1, singular: true },
    aspectRatio: ASPECT_RATIOS_DEFAULT,
    output: "string",
  },
  "flux-1.1-pro-ultra": {
    id: "flux-1.1-pro-ultra",
    name: "Flux 1.1 Pro Ultra",
    capabilities: { generate: true, edit: false },
    referenceImages: { supported: false, fieldName: "none", maxCount: 0, singular: false },
    aspectRatio: ASPECT_RATIOS_ULTRA,
    output: "string",
  },
  "seedream-4": {
    id: "seedream-4",
    name: "SeedReam 4",
    capabilities: { generate: true, edit: true },
    referenceImages: { supported: true, fieldName: "image_input", maxCount: 10, singular: false },
    aspectRatio: ASPECT_RATIOS_DEFAULT,
    output: "string",
  },
  "recraft-v3": {
    id: "recraft",
    name: "Recraft V3",
    capabilities: { generate: true, edit: false },
    referenceImages: { supported: false, fieldName: "none", maxCount: 0, singular: false },
    aspectRatio: ASPECT_RATIOS_SQUARE,
    output: "string",
  },
  "image-01": {
    id: "minimax",
    name: "MiniMax Image",
    capabilities: { generate: true, edit: false },
    referenceImages: { supported: false, fieldName: "none", maxCount: 0, singular: false },
    aspectRatio: { supported: ["1:1", "9:16", "16:9", "3:4", "4:3"], default: "1:1" },
    output: "array",
  },
  "gpt-image-1": {
    id: "gpt-image-1",
    name: "OpenAI GPT Image 1",
    capabilities: { generate: true, edit: true },
    referenceImages: { supported: true, fieldName: "input_image", maxCount: 1, singular: true },
    aspectRatio: { supported: ["1:1", "2:3", "3:2"], default: "1:1" },
    output: "string",
  },
  "ideogram-v3-turbo": {
    id: "ideogram-v3",
    name: "Ideogram v3",
    capabilities: { generate: true, edit: false },
    referenceImages: { supported: false, fieldName: "none", maxCount: 0, singular: false },
    aspectRatio: { supported: ["1:1", "9:16", "16:9", "2:3", "3:2"], default: "1:1" },
    output: "string",
  },
  "flux-1.1-pro": {
    id: "flux",
    name: "Flux 1.1 Pro",
    capabilities: { generate: true, edit: false },
    referenceImages: { supported: false, fieldName: "none", maxCount: 0, singular: false },
    aspectRatio: { supported: ["1:1", "9:16", "16:9"], default: "1:1" },
    output: "string",
  },
}

function mapModel(raw: ReplicateModel): ImageModelEntry {
  const providerId = `${raw.owner}/${raw.name}`
  const spec = MODEL_SPECS[raw.name] ?? {
    id: raw.name,
    name: raw.name,
    capabilities: { generate: true, edit: false },
    referenceImages: { supported: false, fieldName: "none" as const, maxCount: 0, singular: false },
    aspectRatio: ASPECT_RATIOS_DEFAULT,
    output: "string" as const,
  }

  const pricing = PRICING[raw.name] ?? {
    costPerImage: 0.03,
    costTier: "low" as const,
    baseCost: 0.03,
    creditCost: 3,
  }

  return {
    id: spec.id,
    name: spec.name,
    providerId,
    provider: raw.owner === "openai" ? "openai" : raw.owner === "minimax" ? "minimax" : "replicate",
    capabilities: spec.capabilities,
    referenceImages: spec.referenceImages,
    aspectRatio: spec.aspectRatio,
    output: spec.output,
    pricing: {
      costPerImage: pricing.costPerImage,
      costTier: pricing.costTier,
      billingUnit: "per_image" as const,
      baseCost: pricing.baseCost,
      ...(pricing.creditCost !== undefined ? { creditCost: pricing.creditCost } : {}),
      ...(pricing.overrideCreditCost !== undefined ? { overrideCreditCost: pricing.overrideCreditCost } : {}),
    },
    description: raw.description,
    agentVisible: AGENT_VISIBLE.has(raw.name),
    ...(spec.triggerWord ? { triggerWord: spec.triggerWord } : {}),
  }
}

// ── Generator ────────────────────────────────────────────────────────────

// `id` MUST match the snapshot filename stem — the framework's
// `ctx.fetchSource` resolves `snapshots/<id>.json` (single dist-safe reader;
// generators never touch the filesystem themselves).
export const REPLICATE_SOURCE: CatalogSource = {
  id: "image-replicate",
  url: "https://api.replicate.com/v1/models?query=image+generation",
  headers: { Authorization: "Bearer env:REPLICATE_API_TOKEN" },
}

export const imageReplicate: CatalogGenerator = defineGenerator({
  name: "image:replicate",
  modality: "image",
  sources: [REPLICATE_SOURCE],

  async generate(ctx: GeneratorContext): Promise<GeneratedFiles> {
    // Snapshot-first (refresh re-fetches) — both handled by the framework.
    const data = (await ctx.fetchSource(REPLICATE_SOURCE)) as ReplicateSnapshot

    const entries = data.models.map(mapModel)

    const lines: string[] = [
      "// Generated by @agentproto/catalog-sync generator image:replicate",
      "// DO NOT EDIT MANUALLY — regenerate with catalog-sync",
      "",
      "import type { ImageModelDefinition } from \"@agentproto/model-catalog/image\"",
      "",
      "export const REPLICATE_IMAGE_MODELS: Record<string, ImageModelDefinition> = {",
    ]

    for (const e of entries) {
      const trigger = e.triggerWord ? `,\n    triggerWord: ${JSON.stringify(e.triggerWord)}` : ""
      const creditCost = e.pricing.creditCost !== undefined
        ? `,\n      creditCost: ${e.pricing.creditCost}`
        : ""
      const override = e.pricing.overrideCreditCost !== undefined
        ? `,\n      overrideCreditCost: ${e.pricing.overrideCreditCost}`
        : ""

      lines.push(`  ${JSON.stringify(e.id)}: {`)
      lines.push(`    id: ${JSON.stringify(e.id)},`)
      lines.push(`    name: ${JSON.stringify(e.name)},`)
      lines.push(`    providerId: ${JSON.stringify(e.providerId)},`)
      lines.push(`    provider: ${JSON.stringify(e.provider)},`)
      lines.push(`    capabilities: { generate: ${e.capabilities.generate}, edit: ${e.capabilities.edit}${e.capabilities.upscale ? `, upscale: ${e.capabilities.upscale}` : ""} },`)
      lines.push(`    referenceImages: {`)
      lines.push(`      supported: ${e.referenceImages.supported},`)
      lines.push(`      fieldName: ${JSON.stringify(e.referenceImages.fieldName)},`)
      lines.push(`      maxCount: ${e.referenceImages.maxCount},`)
      lines.push(`      singular: ${e.referenceImages.singular},`)
      lines.push(`    },`)
      lines.push(`    aspectRatio: {`)
      lines.push(`      supported: [${e.aspectRatio.supported.map(a => JSON.stringify(a)).join(", ")}],`)
      lines.push(`      default: ${JSON.stringify(e.aspectRatio.default)},`)
      lines.push(`    },`)
      lines.push(`    output: ${JSON.stringify(e.output)},`)
      lines.push(`    pricing: {`)
      lines.push(`      costPerImage: ${e.pricing.costPerImage},`)
      lines.push(`      costTier: ${JSON.stringify(e.pricing.costTier)},`)
      lines.push(`      billingUnit: ${JSON.stringify(e.pricing.billingUnit)},`)
      lines.push(`      baseCost: ${e.pricing.baseCost},${creditCost}${override}`)
      lines.push(`    },`)
      lines.push(`    description: ${JSON.stringify(e.description)},`)
      lines.push(`    agentVisible: ${e.agentVisible},${trigger}`)
      lines.push(`  },`)
    }

    lines.push("}")
    lines.push("")

    const outputPath = "packages/catalog-sync/generated/image-replicate.generated.ts"
    return { [outputPath]: lines.join("\n") }
  },
})
