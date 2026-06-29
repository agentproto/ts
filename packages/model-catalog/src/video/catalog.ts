/**
 * Video Model Catalog — single source of truth for all video models.
 *
 * Migrated from `packages/integration/video/src/models/catalog.ts`. The
 * original location now re-exports from here so every existing consumer
 * keeps working.
 *
 * Adding a model = 1 entry here + 1 serializer in
 * `packages/integration/video/src/providers/replicate/replicate-serializers.ts`.
 */

import type { BillingUnit, CostMultipliers } from "../schema/cost-units.js"

export interface VideoModelDefinition {
  id: string
  name: string
  /** Replicate model ID */
  providerId: string
  provider: "replicate" | "minimax"
  capabilities: {
    textToVideo: boolean
    imageToVideo: boolean
    subjectReference: boolean
    audio: boolean
  }
  maxDuration: number
  supportedResolutions: Array<"720p" | "1080p">
  supportedAspectRatios: string[]
  pricing: {
    /** @deprecated Use billingUnit + baseCost instead */
    costPerClip: number
    /** @deprecated Derived from baseCost */
    costTier: "low" | "medium" | "high"
    /** How the provider bills: per_clip for most, per_second for lip-sync */
    billingUnit: BillingUnit
    /** Our production cost in USD */
    baseCost: number
    /** What baseCost covers */
    baseCostUnit: string
    /** Provider-side cost multipliers for resolution/duration/mode. */
    multipliers?: CostMultipliers
    /**
     * @deprecated Credits derived at call time. Markup applied to
     * `baseCost`, then `multipliers` re-applied. Kept optional for
     * back-compat. Use `overrideCreditCost` for opt-outs.
     */
    creditCost?: number
    /**
     * @deprecated Use `multipliers`; markup re-uses the same shape.
     */
    creditMultipliers?: CostMultipliers
    /** Bypass markup formula and charge exactly this base. */
    overrideCreditCost?: number
  }
  description: string
  agentVisible: boolean
}

export const VIDEO_MODEL_CATALOG: Record<string, VideoModelDefinition> = {
  // ─── Active agent-visible models ─────────────────────────────────────────

  "google/veo-3.1-fast": {
    id: "google/veo-3.1-fast",
    name: "Veo 3.1 Fast",
    providerId: "google/veo-3.1-fast",
    provider: "replicate",
    capabilities: {
      textToVideo: true,
      imageToVideo: true,
      subjectReference: false,
      audio: true,
    },
    maxDuration: 8,
    supportedResolutions: ["720p", "1080p"],
    supportedAspectRatios: ["16:9", "9:16"],
    pricing: {
      costPerClip: 0.15,
      costTier: "medium",
      billingUnit: "per_clip",
      baseCost: 0.8,
      baseCostUnit: "1 clip 8s",
      creditCost: 80,
      multipliers: { resolution: { "720p": 1.0, "1080p": 1.5 } },
      creditMultipliers: { resolution: { "720p": 1.0, "1080p": 1.5 } },
    },
    description: "Fast iteration, good quality",
    agentVisible: true,
  },

  "google/veo-3.1": {
    id: "google/veo-3.1",
    name: "Veo 3.1",
    providerId: "google/veo-3.1",
    provider: "replicate",
    capabilities: {
      textToVideo: true,
      imageToVideo: true,
      subjectReference: true,
      audio: true,
    },
    maxDuration: 8,
    supportedResolutions: ["720p", "1080p"],
    supportedAspectRatios: ["16:9", "9:16"],
    pricing: {
      costPerClip: 0.75,
      costTier: "high",
      billingUnit: "per_clip",
      baseCost: 1.5,
      baseCostUnit: "1 clip 8s",
      creditCost: 150,
      multipliers: { resolution: { "720p": 1.0, "1080p": 1.5 } },
      creditMultipliers: { resolution: { "720p": 1.0, "1080p": 1.5 } },
    },
    description: "Premium quality, 1080p, reference images",
    agentVisible: true,
  },

  "kwaivgi/kling-v3-omni-video": {
    id: "kwaivgi/kling-v3-omni-video",
    name: "Kling V3 Omni",
    providerId: "kwaivgi/kling-v3-omni-video",
    provider: "replicate",
    capabilities: {
      textToVideo: true,
      imageToVideo: true,
      subjectReference: true,
      audio: true,
    },
    maxDuration: 15,
    supportedResolutions: ["720p"],
    supportedAspectRatios: ["16:9", "9:16"],
    pricing: {
      costPerClip: 0.1,
      costTier: "low",
      billingUnit: "per_clip",
      baseCost: 0.5,
      baseCostUnit: "1 clip 720p 5s",
      creditCost: 50,
      multipliers: { duration: { 5: 1.0, 10: 2.0, 15: 3.0 } },
      creditMultipliers: { duration: { 5: 1.0, 10: 2.0, 15: 3.0 } },
    },
    description: "Multi-shot, native audio, subject reference",
    agentVisible: true,
  },

  "kwaivgi/kling-v3-video": {
    id: "kwaivgi/kling-v3-video",
    name: "Kling V3",
    providerId: "kwaivgi/kling-v3-video",
    provider: "replicate",
    capabilities: {
      textToVideo: true,
      imageToVideo: true,
      subjectReference: false,
      audio: true,
    },
    maxDuration: 15,
    supportedResolutions: ["720p"],
    supportedAspectRatios: ["16:9", "9:16"],
    pricing: {
      costPerClip: 0.1,
      costTier: "low",
      billingUnit: "per_clip",
      baseCost: 0.5,
      baseCostUnit: "1 clip 720p 5s",
      creditCost: 50,
      multipliers: {
        duration: { 5: 1.0, 10: 2.0, 15: 3.0 },
        mode: { standard: 1.0, pro: 1.5 },
      },
      creditMultipliers: {
        duration: { 5: 1.0, 10: 2.0, 15: 3.0 },
        mode: { standard: 1.0, pro: 1.5 },
      },
    },
    description: "Text-to-video with audio",
    agentVisible: true,
  },

  // ─── Pipeline-only models (used in content pipeline videoModel enum) ─────

  "openai/sora-2": {
    id: "openai/sora-2",
    name: "Sora 2",
    providerId: "openai/sora-2",
    provider: "replicate",
    capabilities: {
      textToVideo: true,
      imageToVideo: true,
      subjectReference: false,
      audio: false,
    },
    maxDuration: 10,
    supportedResolutions: ["720p", "1080p"],
    supportedAspectRatios: ["16:9", "9:16", "1:1"],
    pricing: {
      costPerClip: 0.2,
      costTier: "medium",
      billingUnit: "per_clip",
      baseCost: 1.0,
      baseCostUnit: "1 clip 10s",
      creditCost: 100,
    },
    description: "OpenAI Sora 2",
    agentVisible: true,
  },

  "openai/sora-2-pro": {
    id: "openai/sora-2-pro",
    name: "Sora 2 Pro",
    providerId: "openai/sora-2-pro",
    provider: "replicate",
    capabilities: {
      textToVideo: true,
      imageToVideo: true,
      subjectReference: false,
      audio: false,
    },
    maxDuration: 10,
    supportedResolutions: ["720p", "1080p"],
    supportedAspectRatios: ["16:9", "9:16", "1:1"],
    pricing: {
      costPerClip: 0.4,
      costTier: "high",
      billingUnit: "per_clip",
      baseCost: 1.2,
      baseCostUnit: "1 clip 10s",
      creditCost: 120,
    },
    description: "OpenAI Sora 2 Pro quality",
    agentVisible: true,
  },

  "xai/grok-imagine-video": {
    id: "xai/grok-imagine-video",
    name: "Grok Imagine Video",
    providerId: "xai/grok-imagine-video",
    provider: "replicate",
    capabilities: {
      textToVideo: true,
      imageToVideo: false,
      subjectReference: false,
      audio: false,
    },
    maxDuration: 10,
    supportedResolutions: ["720p"],
    supportedAspectRatios: ["16:9", "9:16"],
    pricing: {
      costPerClip: 0.1,
      costTier: "low",
      billingUnit: "per_clip",
      baseCost: 0.6,
      baseCostUnit: "1 clip 10s",
      creditCost: 60,
    },
    description: "xAI Grok video generation",
    agentVisible: true,
  },

  "minimax/hailuo-2.3": {
    id: "minimax/hailuo-2.3",
    name: "Hailuo 2.3",
    providerId: "minimax/hailuo-2.3",
    provider: "replicate",
    capabilities: {
      textToVideo: true,
      imageToVideo: true,
      subjectReference: false,
      audio: false,
    },
    maxDuration: 6,
    supportedResolutions: ["720p"],
    supportedAspectRatios: ["16:9", "9:16", "1:1"],
    pricing: {
      costPerClip: 0.08,
      costTier: "low",
      billingUnit: "per_clip",
      baseCost: 0.5,
      baseCostUnit: "1 clip 768p 6s",
      creditCost: 50,
      multipliers: {
        duration: { 6: 1.0, 10: 1.7 },
        resolution: { "768p": 1.0, "1080p": 1.5 },
      },
      creditMultipliers: {
        duration: { 6: 1.0, 10: 1.7 },
        resolution: { "768p": 1.0, "1080p": 1.5 },
      },
    },
    description: "MiniMax Hailuo 2.3",
    agentVisible: true,
  },

  "minimax/hailuo-2.3-fast": {
    id: "minimax/hailuo-2.3-fast",
    name: "Hailuo 2.3 Fast",
    providerId: "minimax/hailuo-2.3-fast",
    provider: "replicate",
    capabilities: {
      textToVideo: true,
      imageToVideo: true,
      subjectReference: false,
      audio: false,
    },
    maxDuration: 6,
    supportedResolutions: ["720p"],
    supportedAspectRatios: ["16:9", "9:16", "1:1"],
    pricing: {
      costPerClip: 0.04,
      costTier: "low",
      billingUnit: "per_clip",
      baseCost: 0.4,
      baseCostUnit: "1 clip 6s",
      creditCost: 40,
    },
    description: "MiniMax Hailuo 2.3 Fast",
    agentVisible: true,
  },

  "minimax/hailuo-02": {
    id: "minimax/hailuo-02",
    name: "Hailuo 02",
    providerId: "minimax/hailuo-02",
    provider: "replicate",
    capabilities: {
      textToVideo: true,
      imageToVideo: true,
      subjectReference: false,
      audio: false,
    },
    maxDuration: 6,
    supportedResolutions: ["720p"],
    supportedAspectRatios: ["16:9", "9:16", "1:1"],
    pricing: {
      costPerClip: 0.06,
      costTier: "low",
      billingUnit: "per_clip",
      baseCost: 0.5,
      baseCostUnit: "1 clip 6s",
      creditCost: 50,
    },
    description: "MiniMax Hailuo 02",
    agentVisible: true,
  },

  "bytedance/seedance-1-pro-fast": {
    id: "bytedance/seedance-1-pro-fast",
    name: "Seedance 1 Pro Fast",
    providerId: "bytedance/seedance-1-pro-fast",
    provider: "replicate",
    capabilities: {
      textToVideo: true,
      imageToVideo: true,
      subjectReference: false,
      audio: false,
    },
    maxDuration: 8,
    supportedResolutions: ["720p"],
    supportedAspectRatios: ["16:9", "9:16", "1:1"],
    pricing: {
      costPerClip: 0.08,
      costTier: "low",
      billingUnit: "per_clip",
      baseCost: 0.6,
      baseCostUnit: "1 clip 8s",
      creditCost: 60,
    },
    description: "ByteDance Seedance Pro Fast",
    agentVisible: true,
  },

  "bytedance/seedance-1-lite": {
    id: "bytedance/seedance-1-lite",
    name: "Seedance 1 Lite",
    providerId: "bytedance/seedance-1-lite",
    provider: "replicate",
    capabilities: {
      textToVideo: true,
      imageToVideo: true,
      subjectReference: false,
      audio: false,
    },
    maxDuration: 8,
    supportedResolutions: ["720p"],
    supportedAspectRatios: ["16:9", "9:16", "1:1"],
    pricing: {
      costPerClip: 0.04,
      costTier: "low",
      billingUnit: "per_clip",
      baseCost: 0.4,
      baseCostUnit: "1 clip 8s",
      creditCost: 40,
    },
    description: "ByteDance Seedance Lite",
    agentVisible: true,
  },

  "wan-video/wan-2.5-t2v": {
    id: "wan-video/wan-2.5-t2v",
    name: "Wan 2.5 T2V",
    providerId: "wan-video/wan-2.5-t2v",
    provider: "replicate",
    capabilities: {
      textToVideo: true,
      imageToVideo: false,
      subjectReference: false,
      audio: false,
    },
    maxDuration: 8,
    supportedResolutions: ["720p"],
    supportedAspectRatios: ["16:9", "9:16", "1:1"],
    pricing: {
      costPerClip: 0.06,
      costTier: "low",
      billingUnit: "per_clip",
      baseCost: 0.5,
      baseCostUnit: "1 clip 8s",
      creditCost: 50,
    },
    description: "Wan 2.5 text-to-video",
    agentVisible: true,
  },

  "wan-video/wan-2.5-i2v": {
    id: "wan-video/wan-2.5-i2v",
    name: "Wan 2.5 I2V",
    providerId: "wan-video/wan-2.5-i2v",
    provider: "replicate",
    capabilities: {
      textToVideo: false,
      imageToVideo: true,
      subjectReference: false,
      audio: false,
    },
    maxDuration: 8,
    supportedResolutions: ["720p"],
    supportedAspectRatios: ["16:9", "9:16", "1:1"],
    pricing: {
      costPerClip: 0.06,
      costTier: "low",
      billingUnit: "per_clip",
      baseCost: 0.5,
      baseCostUnit: "1 clip 8s",
      creditCost: 50,
    },
    description: "Wan 2.5 image-to-video",
    agentVisible: true,
  },

  "wan-video/wan-2.5-i2v-fast": {
    id: "wan-video/wan-2.5-i2v-fast",
    name: "Wan 2.5 I2V Fast",
    providerId: "wan-video/wan-2.5-i2v-fast",
    provider: "replicate",
    capabilities: {
      textToVideo: false,
      imageToVideo: true,
      subjectReference: false,
      audio: false,
    },
    maxDuration: 8,
    supportedResolutions: ["720p"],
    supportedAspectRatios: ["16:9", "9:16", "1:1"],
    pricing: {
      costPerClip: 0.03,
      costTier: "low",
      billingUnit: "per_clip",
      baseCost: 0.3,
      baseCostUnit: "1 clip 8s",
      creditCost: 30,
    },
    description: "Wan 2.5 image-to-video fast",
    agentVisible: true,
  },

  "pixverse/pixverse-v5.6": {
    id: "pixverse/pixverse-v5.6",
    name: "PixVerse V5.6",
    providerId: "pixverse/pixverse-v5.6",
    provider: "replicate",
    capabilities: {
      textToVideo: true,
      imageToVideo: true,
      subjectReference: false,
      audio: false,
    },
    maxDuration: 8,
    supportedResolutions: ["720p"],
    supportedAspectRatios: ["16:9", "9:16", "1:1"],
    pricing: {
      costPerClip: 0.06,
      costTier: "low",
      billingUnit: "per_clip",
      baseCost: 0.5,
      baseCostUnit: "1 clip 8s",
      creditCost: 50,
    },
    description: "PixVerse V5.6",
    agentVisible: true,
  },

  "runwayml/gen-4.5": {
    id: "runwayml/gen-4.5",
    name: "Runway Gen 4.5",
    providerId: "runwayml/gen-4.5",
    provider: "replicate",
    capabilities: {
      textToVideo: true,
      imageToVideo: true,
      subjectReference: false,
      audio: false,
    },
    maxDuration: 10,
    supportedResolutions: ["720p", "1080p"],
    supportedAspectRatios: ["16:9", "9:16", "1:1"],
    pricing: {
      costPerClip: 0.25,
      costTier: "medium",
      billingUnit: "per_clip",
      baseCost: 1.0,
      baseCostUnit: "1 clip 5s",
      creditCost: 100,
      multipliers: { duration: { 5: 1.0, 10: 2.0 } },
      creditMultipliers: { duration: { 5: 1.0, 10: 2.0 } },
    },
    description: "Runway Gen 4.5",
    agentVisible: true,
  },

  // ─── UGC / Talking Head models ────────────────────────────────────────────

  "veed/fabric-1.0": {
    id: "veed/fabric-1.0",
    name: "Fabric 1.0 (Lip-Sync)",
    providerId: "veed/fabric-1.0",
    provider: "replicate",
    capabilities: {
      textToVideo: false,
      imageToVideo: false,
      subjectReference: false,
      audio: true,
    },
    maxDuration: 60,
    supportedResolutions: ["720p"],
    supportedAspectRatios: ["9:16", "16:9"],
    pricing: {
      costPerClip: 0.05,
      costTier: "low",
      billingUnit: "per_second",
      baseCost: 0.1,
      baseCostUnit: "1 second of output video",
      creditCost: 10,
    },
    description: "Talking head lip-sync from photo + audio (up to 60s)",
    agentVisible: false,
  },

  "pixverse/lipsync": {
    id: "pixverse/lipsync",
    name: "PixVerse Lip-Sync",
    providerId: "pixverse/lipsync",
    provider: "replicate",
    capabilities: {
      textToVideo: false,
      imageToVideo: false,
      subjectReference: false,
      audio: true,
    },
    maxDuration: 30,
    supportedResolutions: ["720p"],
    supportedAspectRatios: ["9:16", "16:9"],
    pricing: {
      costPerClip: 0.05,
      costTier: "low",
      billingUnit: "per_second",
      baseCost: 0.1,
      baseCostUnit: "1 second of output video",
      creditCost: 10,
    },
    description: "PixVerse lip-sync (same image/audio params as fabric-1.0)",
    agentVisible: false,
  },

  "bytedance/dreamactor-m2.0": {
    id: "bytedance/dreamactor-m2.0",
    name: "DreamActor M2.0",
    providerId: "bytedance/dreamactor-m2.0",
    provider: "replicate",
    capabilities: {
      textToVideo: false,
      imageToVideo: false,
      subjectReference: false,
      audio: false,
    },
    maxDuration: 10,
    supportedResolutions: ["720p"],
    supportedAspectRatios: ["9:16", "16:9"],
    pricing: {
      costPerClip: 0.1,
      costTier: "low",
      billingUnit: "per_second",
      baseCost: 0.1,
      baseCostUnit: "1 second of output video",
      creditCost: 10,
    },
    description: "Motion transfer: animate any character from driving video",
    agentVisible: false,
  },

  // ─── Legacy / superseded — not exposed to agents ─────────────────────────

  "kwaivgi/kling-v2.5-turbo-pro": {
    id: "kwaivgi/kling-v2.5-turbo-pro",
    name: "Kling V2.5 Turbo Pro",
    providerId: "kwaivgi/kling-v2.5-turbo-pro",
    provider: "replicate",
    capabilities: {
      textToVideo: true,
      imageToVideo: true,
      subjectReference: false,
      audio: false,
    },
    maxDuration: 10,
    supportedResolutions: ["720p"],
    supportedAspectRatios: ["16:9", "9:16"],
    pricing: {
      costPerClip: 0.07,
      costTier: "low",
      billingUnit: "per_clip",
      baseCost: 0.4,
      baseCostUnit: "1 clip 10s",
      creditCost: 40,
    },
    description: "Fast and cheap (superseded by v3)",
    agentVisible: false,
  },

  "luma/ray-flash-2-540p": {
    id: "luma/ray-flash-2-540p",
    name: "Luma Ray Flash 2",
    providerId: "luma/ray-flash-2-540p",
    provider: "replicate",
    capabilities: {
      textToVideo: true,
      imageToVideo: true,
      subjectReference: false,
      audio: false,
    },
    maxDuration: 9,
    supportedResolutions: ["720p"],
    supportedAspectRatios: [
      "1:1",
      "3:4",
      "4:3",
      "9:16",
      "16:9",
      "9:21",
      "21:9",
    ],
    pricing: {
      costPerClip: 0.05,
      costTier: "low",
      billingUnit: "per_clip",
      baseCost: 0.4,
      baseCostUnit: "1 clip 9s",
      creditCost: 40,
    },
    description: "Luma Ray Flash 2 (less used)",
    agentVisible: false,
  },
}

// ─── Derived arrays ────────────────────────────────────────────────────────

/** All video model IDs */
export const VIDEO_MODEL_IDS = Object.keys(VIDEO_MODEL_CATALOG) as [
  string,
  ...string[],
]

/** Agent-visible video model IDs */
export const AGENT_VIDEO_MODEL_IDS = Object.entries(VIDEO_MODEL_CATALOG)
  .filter(([, m]) => m.agentVisible)
  .map(([id]) => id) as [string, ...string[]]

/** Generate a markdown table of agent-visible video models for prompt blocks */
export function generateVideoModelTable(): string {
  return Object.values(VIDEO_MODEL_CATALOG)
    .filter(m => m.agentVisible)
    .map(
      m =>
        `| \`${m.id}\` | ~$${m.pricing.costPerClip}/clip | ${m.description} |`
    )
    .join("\n")
}
