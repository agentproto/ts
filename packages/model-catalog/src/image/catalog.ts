/**
 * Image Model Catalog — single source of truth for all image models.
 *
 * Migrated from `packages/integration/image/src/models/catalog.ts`. The
 * original location now re-exports from here so every existing consumer
 * (replicate-serializers, prompt blocks, Katchy UI) keeps working.
 *
 * Adding a model = 1 entry here + 1 serializer in
 * `packages/integration/image/src/providers/replicate/replicate-serializers.ts`.
 * Consumers import derived arrays (`AGENT_GENERATIVE_MODEL_IDS`, etc.)
 * instead of hardcoding model names.
 */

export interface ImageModelDefinition {
  id: string
  name: string
  /** Replicate model ID (e.g. "google/nano-banana-pro") */
  providerId: string
  provider: string
  capabilities: {
    generate: boolean
    edit: boolean
    upscale?: boolean
  }
  referenceImages: {
    supported: boolean
    /** Replicate input field name for reference images */
    fieldName: "image_input" | "input_images" | "input_image" | "none"
    maxCount: number
    /** true for models that accept a single URI string (not array) */
    singular: boolean
  }
  aspectRatio: {
    supported: string[]
    default: string
  }
  /** Response shape: "string" = single URI, "array" = array of URIs */
  output: "string" | "array"
  pricing: {
    /** @deprecated Use billingUnit + baseCost instead */
    costPerImage: number
    /** @deprecated Derived from baseCost */
    costTier: "low" | "medium" | "high"
    /** Always "per_image" for image models */
    billingUnit: "per_image"
    /** Our production cost in USD per image */
    baseCost: number
    /**
     * @deprecated Credits are derived at call time via
     * `computeCenticredits({ baseCostUsd, category: "image" })`. Field kept
     * optional for back-compat with existing entries; new entries
     * should omit it. Use `overrideCreditCost` for strategic opt-outs.
     */
    creditCost?: number
    /**
     * Bypass the markup formula and charge exactly this many credits
     * per image. Use sparingly — most pricing should flow through the
     * category markup so a global tune is one config change.
     */
    overrideCreditCost?: number
  }
  description: string
  /** When false, model exists but isn't exposed in agent prompts/zod enums */
  agentVisible: boolean
  /** Trigger word that must be included in the prompt to activate the fine-tune (e.g. "TOK") */
  triggerWord?: string
}

export const IMAGE_MODEL_CATALOG: Record<string, ImageModelDefinition> = {
  // ─── Active agent-visible models ─────────────────────────────────────────

  "nano-banana-pro": {
    id: "nano-banana-pro",
    name: "Nano Banana Pro",
    providerId: "google/nano-banana-pro",
    provider: "replicate",
    capabilities: { generate: true, edit: true },
    referenceImages: {
      supported: true,
      fieldName: "image_input",
      maxCount: 14,
      singular: false,
    },
    aspectRatio: {
      supported: [
        "1:1",
        "9:16",
        "16:9",
        "2:3",
        "3:2",
        "3:4",
        "4:3",
        "4:5",
        "5:4",
        "21:9",
      ],
      default: "match_input_image",
    },
    output: "string",
    pricing: {
      costPerImage: 0.15,
      costTier: "high",
      billingUnit: "per_image",
      baseCost: 0.15,
      creditCost: 10,
    },
    description: "Best quality, excellent text rendering (Gemini Pro)",
    agentVisible: true,
  },

  "nano-banana-2": {
    id: "nano-banana-2",
    name: "Nano Banana 2",
    providerId: "google/nano-banana-2",
    provider: "replicate",
    capabilities: { generate: true, edit: true },
    referenceImages: {
      supported: true,
      fieldName: "image_input",
      maxCount: 4,
      singular: false,
    },
    aspectRatio: {
      supported: [
        "1:1",
        "9:16",
        "16:9",
        "2:3",
        "3:2",
        "3:4",
        "4:3",
        "4:5",
        "5:4",
      ],
      default: "match_input_image",
    },
    output: "string",
    pricing: {
      costPerImage: 0.06,
      costTier: "medium",
      billingUnit: "per_image",
      baseCost: 0.06,
      creditCost: 5,
    },
    description:
      "Higher quality, supports up to 4K resolution (Gemini 2.5 Pro)",
    agentVisible: true,
  },

  "nano-banana": {
    id: "nano-banana",
    name: "Nano Banana",
    providerId: "google/nano-banana",
    provider: "replicate",
    capabilities: { generate: true, edit: true },
    referenceImages: {
      supported: true,
      fieldName: "image_input",
      maxCount: 4,
      singular: false,
    },
    aspectRatio: {
      supported: ["1:1", "9:16", "16:9", "2:3", "3:2", "3:4", "4:3"],
      default: "match_input_image",
    },
    output: "string",
    pricing: {
      costPerImage: 0.04,
      costTier: "low",
      billingUnit: "per_image",
      baseCost: 0.04,
      creditCost: 5,
    },
    description: "Fast generation (Gemini Flash), good for bulk",
    agentVisible: true,
  },

  "flux-2-dev": {
    id: "flux-2-dev",
    name: "Flux 2 Dev",
    providerId: "black-forest-labs/flux-2-dev",
    provider: "replicate",
    capabilities: { generate: true, edit: true },
    referenceImages: {
      supported: true,
      fieldName: "input_images",
      maxCount: 5,
      singular: false,
    },
    aspectRatio: {
      supported: [
        "1:1",
        "9:16",
        "16:9",
        "2:3",
        "3:2",
        "3:4",
        "4:3",
        "4:5",
        "5:4",
      ],
      default: "1:1",
    },
    output: "string",
    pricing: {
      costPerImage: 0.03,
      costTier: "low",
      billingUnit: "per_image",
      baseCost: 0.03,
      creditCost: 3,
    },
    description: "General purpose, fast, good quality",
    agentVisible: true,
  },

  "flux-kontext-pro": {
    id: "flux-kontext-pro",
    name: "Flux Kontext Pro",
    providerId: "black-forest-labs/flux-kontext-pro",
    provider: "replicate",
    capabilities: { generate: true, edit: true },
    referenceImages: {
      supported: true,
      fieldName: "input_image",
      maxCount: 1,
      singular: true,
    },
    aspectRatio: {
      supported: ["1:1", "9:16", "16:9", "2:3", "3:2", "3:4", "4:3"],
      default: "1:1",
    },
    output: "string",
    pricing: {
      costPerImage: 0.04,
      costTier: "low",
      billingUnit: "per_image",
      baseCost: 0.04,
      creditCost: 5,
    },
    description: "Character consistency with reference images (edit mode)",
    agentVisible: true,
  },

  "flux-kontext-max": {
    id: "flux-kontext-max",
    name: "Flux Kontext Max",
    providerId: "black-forest-labs/flux-kontext-max",
    provider: "replicate",
    capabilities: { generate: true, edit: true },
    referenceImages: {
      supported: true,
      fieldName: "input_image",
      maxCount: 1,
      singular: true,
    },
    aspectRatio: {
      supported: ["1:1", "9:16", "16:9", "2:3", "3:2", "3:4", "4:3"],
      default: "1:1",
    },
    output: "string",
    pricing: {
      costPerImage: 0.08,
      costTier: "medium",
      billingUnit: "per_image",
      baseCost: 0.08,
      creditCost: 8,
    },
    description: "Higher quality kontext editing",
    agentVisible: true,
  },

  "seedream-4": {
    id: "seedream-4",
    name: "SeedReam 4",
    providerId: "bytedance/seedream-4",
    provider: "replicate",
    capabilities: { generate: true, edit: true },
    referenceImages: {
      supported: true,
      fieldName: "image_input",
      maxCount: 10,
      singular: false,
    },
    aspectRatio: {
      supported: ["1:1", "9:16", "16:9", "2:3", "3:2", "3:4", "4:3"],
      default: "1:1",
    },
    output: "string",
    pricing: {
      costPerImage: 0.03,
      costTier: "low",
      billingUnit: "per_image",
      baseCost: 0.03,
      creditCost: 3,
    },
    description: "Photorealistic, good for landscapes",
    agentVisible: true,
  },

  recraft: {
    id: "recraft",
    name: "Recraft V3",
    providerId: "recraft-ai/recraft-v3",
    provider: "replicate",
    capabilities: { generate: true, edit: false },
    referenceImages: {
      supported: false,
      fieldName: "none",
      maxCount: 0,
      singular: false,
    },
    aspectRatio: { supported: ["1:1"], default: "1:1" },
    output: "string",
    pricing: {
      costPerImage: 0.04,
      costTier: "low",
      billingUnit: "per_image",
      baseCost: 0.04,
      creditCost: 5,
    },
    description: "Stylized illustrations and designs",
    agentVisible: true,
  },

  minimax: {
    id: "minimax",
    name: "MiniMax Image",
    providerId: "minimax/image-01",
    provider: "minimax",
    capabilities: { generate: true, edit: false },
    referenceImages: {
      supported: false,
      fieldName: "none",
      maxCount: 0,
      singular: false,
    },
    aspectRatio: {
      supported: ["1:1", "9:16", "16:9", "3:4", "4:3"],
      default: "1:1",
    },
    output: "array",
    pricing: {
      costPerImage: 0.02,
      costTier: "low",
      billingUnit: "per_image",
      baseCost: 0.02,
      creditCost: 2,
    },
    description: "Very fast, cheaper",
    agentVisible: true,
  },

  "avatar-001": {
    id: "avatar-001",
    name: "Avatar Model 001",
    providerId: "agentiknet/avatar-model-001",
    provider: "replicate",
    capabilities: { generate: true, edit: true },
    referenceImages: {
      supported: true,
      fieldName: "image_input",
      maxCount: 1,
      singular: true,
    },
    aspectRatio: {
      supported: [
        "1:1",
        "16:9",
        "21:9",
        "3:2",
        "2:3",
        "4:5",
        "5:4",
        "3:4",
        "4:3",
        "9:16",
        "9:21",
      ],
      default: "1:1",
    },
    output: "array",
    pricing: {
      costPerImage: 0.03,
      costTier: "low",
      billingUnit: "per_image",
      baseCost: 0.03,
      creditCost: 3,
    },
    description: "Fine-tuned avatar model (trigger word: TOK)",
    agentVisible: true,
    triggerWord: "TOK",
  },

  "simone-infographic": {
    id: "simone-infographic",
    name: "Simone Infographic",
    providerId: "agentik/custom-simone_infographic_1",
    provider: "replicate",
    capabilities: { generate: true, edit: true },
    referenceImages: {
      supported: true,
      fieldName: "image_input",
      maxCount: 1,
      singular: true,
    },
    aspectRatio: {
      supported: [
        "1:1",
        "16:9",
        "21:9",
        "3:2",
        "2:3",
        "4:5",
        "5:4",
        "3:4",
        "4:3",
        "9:16",
        "9:21",
      ],
      default: "1:1",
    },
    output: "array",
    pricing: {
      costPerImage: 0.03,
      costTier: "low",
      billingUnit: "per_image",
      baseCost: 0.03,
      creditCost: 3,
    },
    description: "Fine-tuned Flux model for Simone infographic style",
    agentVisible: true,
  },

  "flux-1.1-pro-ultra": {
    id: "flux-1.1-pro-ultra",
    name: "Flux 1.1 Pro Ultra",
    providerId: "black-forest-labs/flux-1.1-pro-ultra",
    provider: "replicate",
    capabilities: { generate: true, edit: false },
    referenceImages: {
      supported: false,
      fieldName: "none",
      maxCount: 0,
      singular: false,
    },
    aspectRatio: {
      supported: ["1:1", "9:16", "16:9", "21:9", "9:21", "3:4", "4:3"],
      default: "1:1",
    },
    output: "string",
    pricing: {
      costPerImage: 0.06,
      costTier: "medium",
      billingUnit: "per_image",
      baseCost: 0.06,
      creditCost: 8,
    },
    description: "Highest-fidelity Flux (4MP, photorealistic)",
    agentVisible: true,
  },

  "gpt-image-1": {
    id: "gpt-image-1",
    name: "OpenAI GPT Image 1",
    providerId: "openai/gpt-image-1",
    provider: "openai",
    capabilities: { generate: true, edit: true },
    referenceImages: {
      supported: true,
      fieldName: "input_image",
      maxCount: 1,
      singular: true,
    },
    aspectRatio: {
      supported: ["1:1", "2:3", "3:2"],
      default: "1:1",
    },
    output: "string",
    pricing: {
      costPerImage: 0.04,
      costTier: "low",
      billingUnit: "per_image",
      baseCost: 0.04,
      creditCost: 5,
    },
    description: "OpenAI native image gen (text-aware, edit-capable)",
    agentVisible: true,
  },

  // ─── Google Imagen (native Gemini API, provider="google") ────────────────
  // Source: https://ai.google.dev/gemini-api/docs/pricing (fetched 2026-05-29)
  // — Imagen 4: Fast $0.02/image, Standard $0.04/image, Ultra $0.06/image.
  // Native Gemini API (not replicate-hosted); text-to-image, no reference input.
  "imagen-4-fast": {
    id: "imagen-4-fast",
    name: "Imagen 4 Fast",
    providerId: "imagen-4.0-fast-generate-001",
    provider: "google",
    capabilities: { generate: true, edit: false },
    referenceImages: {
      supported: false,
      fieldName: "none",
      maxCount: 0,
      singular: false,
    },
    aspectRatio: {
      supported: ["1:1", "9:16", "16:9", "3:4", "4:3"],
      default: "1:1",
    },
    output: "array",
    pricing: {
      costPerImage: 0.02,
      costTier: "low",
      billingUnit: "per_image",
      baseCost: 0.02,
    },
    description: "Google Imagen 4 fast tier — cheapest, lower latency",
    agentVisible: true,
  },

  "imagen-4": {
    id: "imagen-4",
    name: "Imagen 4",
    providerId: "imagen-4.0-generate-001",
    provider: "google",
    capabilities: { generate: true, edit: false },
    referenceImages: {
      supported: false,
      fieldName: "none",
      maxCount: 0,
      singular: false,
    },
    aspectRatio: {
      supported: ["1:1", "9:16", "16:9", "3:4", "4:3"],
      default: "1:1",
    },
    output: "array",
    pricing: {
      costPerImage: 0.04,
      costTier: "low",
      billingUnit: "per_image",
      baseCost: 0.04,
    },
    description: "Google Imagen 4 standard — photorealistic text-to-image",
    agentVisible: true,
  },

  "imagen-4-ultra": {
    id: "imagen-4-ultra",
    name: "Imagen 4 Ultra",
    providerId: "imagen-4.0-ultra-generate-001",
    provider: "google",
    capabilities: { generate: true, edit: false },
    referenceImages: {
      supported: false,
      fieldName: "none",
      maxCount: 0,
      singular: false,
    },
    aspectRatio: {
      supported: ["1:1", "9:16", "16:9", "3:4", "4:3"],
      default: "1:1",
    },
    output: "array",
    pricing: {
      costPerImage: 0.06,
      costTier: "medium",
      billingUnit: "per_image",
      baseCost: 0.06,
    },
    description: "Google Imagen 4 ultra — highest fidelity tier",
    agentVisible: true,
  },

  "ideogram-v3": {
    id: "ideogram-v3",
    name: "Ideogram v3",
    providerId: "ideogram-ai/ideogram-v3-turbo",
    provider: "replicate",
    capabilities: { generate: true, edit: false },
    referenceImages: {
      supported: false,
      fieldName: "none",
      maxCount: 0,
      singular: false,
    },
    aspectRatio: {
      supported: ["1:1", "9:16", "16:9", "2:3", "3:2"],
      default: "1:1",
    },
    output: "string",
    pricing: {
      costPerImage: 0.03,
      costTier: "low",
      billingUnit: "per_image",
      baseCost: 0.03,
      creditCost: 4,
    },
    description: "Excellent text rendering, posters & infographics",
    agentVisible: true,
  },

  // ─── Legacy / less-used — still functional but not exposed to agents ──────

  flux: {
    id: "flux",
    name: "Flux 1.1 Pro",
    providerId: "black-forest-labs/flux-1.1-pro",
    provider: "replicate",
    capabilities: { generate: true, edit: false },
    referenceImages: {
      supported: false,
      fieldName: "none",
      maxCount: 0,
      singular: false,
    },
    aspectRatio: { supported: ["1:1", "9:16", "16:9"], default: "1:1" },
    output: "string",
    pricing: {
      costPerImage: 0.04,
      costTier: "low",
      billingUnit: "per_image",
      baseCost: 0.04,
      creditCost: 5,
    },
    description: "Legacy Flux model",
    agentVisible: false,
  },

  sdxl: {
    id: "sdxl",
    name: "SDXL",
    providerId:
      "stability-ai/sdxl:39ed52f2a78e934b3ba6e2a89f5b1c712de7dfea535525255b1aa35c5565e08b",
    provider: "replicate",
    capabilities: { generate: true, edit: false },
    referenceImages: {
      supported: false,
      fieldName: "none",
      maxCount: 0,
      singular: false,
    },
    aspectRatio: { supported: ["1:1"], default: "1:1" },
    output: "array",
    pricing: {
      costPerImage: 0.01,
      costTier: "low",
      billingUnit: "per_image",
      baseCost: 0.01,
      creditCost: 1,
    },
    description: "Stable Diffusion XL",
    agentVisible: false,
  },

  sd3: {
    id: "sd3",
    name: "SD3",
    providerId:
      "stability-ai/stable-diffusion-3:72c05df2daf615fb5cc07c28b662a2a58feb6a4d0a652e67e5a9959d914a9ed2",
    provider: "replicate",
    capabilities: { generate: true, edit: false },
    referenceImages: {
      supported: false,
      fieldName: "none",
      maxCount: 0,
      singular: false,
    },
    aspectRatio: { supported: ["1:1", "9:16", "16:9"], default: "1:1" },
    output: "array",
    pricing: {
      costPerImage: 0.03,
      costTier: "low",
      billingUnit: "per_image",
      baseCost: 0.03,
      creditCost: 3,
    },
    description: "Stable Diffusion 3",
    agentVisible: false,
  },

  sana: {
    id: "sana",
    name: "SANA",
    providerId: "nvidia/sana",
    provider: "replicate",
    capabilities: { generate: true, edit: false },
    referenceImages: {
      supported: false,
      fieldName: "none",
      maxCount: 0,
      singular: false,
    },
    aspectRatio: { supported: ["1:1"], default: "1:1" },
    output: "array",
    pricing: {
      costPerImage: 0.02,
      costTier: "low",
      billingUnit: "per_image",
      baseCost: 0.02,
      creditCost: 2,
    },
    description: "NVIDIA SANA model",
    agentVisible: false,
  },

  sticker: {
    id: "sticker",
    name: "Sticker Maker",
    providerId:
      "fofr/sticker-maker:58a7099052ed9928ee6a65559caa790bfa8909841261ef588686660189eb9dc8",
    provider: "replicate",
    capabilities: { generate: true, edit: false },
    referenceImages: {
      supported: false,
      fieldName: "none",
      maxCount: 0,
      singular: false,
    },
    aspectRatio: { supported: ["1:1"], default: "1:1" },
    output: "array",
    pricing: {
      costPerImage: 0.01,
      costTier: "low",
      billingUnit: "per_image",
      baseCost: 0.01,
      creditCost: 1,
    },
    description: "Sticker generation",
    agentVisible: false,
  },

  selfie: {
    id: "selfie",
    name: "Selfie Generator",
    providerId:
      "fofr/pulid-base:65ea75658bf120abbbdacab07e89e78a74a6a1b1f504349f4c4e3b01a655ee7a",
    provider: "replicate",
    capabilities: { generate: true, edit: false },
    referenceImages: {
      supported: false,
      fieldName: "none",
      maxCount: 0,
      singular: false,
    },
    aspectRatio: { supported: ["1:1"], default: "1:1" },
    output: "array",
    pricing: {
      costPerImage: 0.02,
      costTier: "low",
      billingUnit: "per_image",
      baseCost: 0.02,
      creditCost: 2,
    },
    description: "Face-driven selfie generation",
    agentVisible: false,
  },
}

// ─── Derived arrays ────────────────────────────────────────────────────────

/** All model IDs */
export const IMAGE_MODEL_IDS = Object.keys(IMAGE_MODEL_CATALOG) as [
  string,
  ...string[],
]

/** Only models visible to agents (for zod enums + prompts) */
export const AGENT_IMAGE_MODEL_IDS = Object.entries(IMAGE_MODEL_CATALOG)
  .filter(([, m]) => m.agentVisible)
  .map(([id]) => id) as [string, ...string[]]

/** Agent-visible models supporting generation */
export const AGENT_GENERATIVE_MODEL_IDS = Object.entries(IMAGE_MODEL_CATALOG)
  .filter(([, m]) => m.agentVisible && m.capabilities.generate)
  .map(([id]) => id) as [string, ...string[]]

/** Agent-visible models supporting editing */
export const AGENT_EDITABLE_MODEL_IDS = Object.entries(IMAGE_MODEL_CATALOG)
  .filter(([, m]) => m.agentVisible && m.capabilities.edit)
  .map(([id]) => id) as [string, ...string[]]

/** Generate a markdown table of agent-visible image models for prompt blocks */
export function generateImageModelTable(): string {
  return Object.values(IMAGE_MODEL_CATALOG)
    .filter(m => m.agentVisible)
    .map(m => {
      const trigger = m.triggerWord
        ? ` ⚠️ Trigger word: \`${m.triggerWord}\``
        : ""
      return `| \`${m.id}\` | ~$${m.pricing.costPerImage} | ${m.description}${trigger} |`
    })
    .join("\n")
}
