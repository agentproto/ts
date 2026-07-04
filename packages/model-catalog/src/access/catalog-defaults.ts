/**
 * Catalog-flag defaults — the layer that runs before any workspace
 * override. Mirrors the access-control plan:
 *   - Default-allow: `lifecycle = stable && agentVisible = true`
 *   - Default-block: `lifecycle = preview` or `lifecycle = deprecated`
 *   - Default-block: any model with `agentVisible = false`
 *
 * Legacy catalog data (image/video) carries `agentVisible` but not
 * `lifecycle` — until v2 normalization, lifecycle defaults to "stable"
 * for every entry. LLM and audio entries default to allow (curated).
 */

import type { ResolvedModel } from "../registry/index.js"

export interface CatalogDefaultDecision {
  allowed: boolean
  reason: string
}

export function evaluateCatalogDefaults(
  model: ResolvedModel
): CatalogDefaultDecision {
  switch (model.kind) {
    case "image":
      return model.def.agentVisible
        ? { allowed: true, reason: "catalog-default:agent-visible" }
        : { allowed: false, reason: "catalog-default:agent-hidden" }
    case "video":
      return model.def.agentVisible
        ? { allowed: true, reason: "catalog-default:agent-visible" }
        : { allowed: false, reason: "catalog-default:agent-hidden" }
    case "llm":
      // LLM entries are curated — every catalog entry is visible.
      return { allowed: true, reason: "catalog-default:llm-curated" }
    case "audio":
      return model.def.agentVisible
        ? { allowed: true, reason: "catalog-default:agent-visible" }
        : { allowed: false, reason: "catalog-default:agent-hidden" }
    case "voice":
      // Voice metadata catalog is curated.
      return { allowed: true, reason: "catalog-default:voice-curated" }
  }
}
