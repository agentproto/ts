/**
 * KnowledgeStackResolver — given a `ResolutionContext` and a registry of
 * `LayerProvider`s, produce the band-ordered list of layers an operator's
 * recall is resolved against.
 *
 * The generalization of `OperatorOverlayResolver` (playbooks): same
 * ctx → registry → priority-sort → ordered-list shape, same deterministic
 * shadow sampling for % rollout. Pure — no I/O. The host turns the emitted
 * refs into mounted FsPorts (see `buildOverlayFromStack`).
 */

import type { Registry } from "@agentproto/registry"
import { sampleShadow } from "../util/shadow-sample.js"
import type {
  LayerProvider,
  ResolutionContext,
  StackEntry,
  StackResolution,
  StackSkip,
} from "./types.js"

export class KnowledgeStackResolver<TSubject = unknown> {
  constructor(
    private readonly registry: Registry<LayerProvider<TSubject>>
  ) {}

  async resolve(
    ctx: ResolutionContext<TSubject>
  ): Promise<StackResolution> {
    // Lower band = higher precedence. Stable order for equal bands is the
    // registry's insertion order (AIP-43 Maps preserve it).
    const providers = [...this.registry.list()].sort((a, b) => a.band - b.band)

    const entries: StackEntry[] = []
    const skipped: StackSkip[] = []

    for (const p of providers) {
      let shadowSampled = false
      if (p.shadow) {
        shadowSampled = sampleShadow(ctx.conversationId, p.id, p.shadow.pct)
        if (!shadowSampled) {
          skipped.push({
            providerId: p.id,
            dimension: p.dimension,
            reason: "shadow-not-sampled",
          })
          continue
        }
      }

      const refs = await p.resolve(ctx)
      if (refs.length === 0) {
        skipped.push({
          providerId: p.id,
          dimension: p.dimension,
          reason: "empty",
        })
        continue
      }

      entries.push({
        providerId: p.id,
        band: p.band,
        mode: p.mode,
        dimension: p.dimension,
        refs,
        shadowSampled,
      })
    }

    return Object.freeze({
      entries: Object.freeze(entries),
      skipped: Object.freeze(skipped),
    })
  }
}
