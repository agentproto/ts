/**
 * OperatorOverlayResolver — given an operator + conversation context,
 * returns the playbook overlays to splice into the operator's prompt.
 *
 * Decision rules:
 *   1. `active` playbooks targeting the operator are ALWAYS included.
 *   2. `shadow` playbooks fire on a deterministic-hash subset of
 *      conversations (`shadowTrafficPct`, default 0.10) — same
 *      conversation always lands the same arm so an eval batch is
 *      reproducible.
 *   3. `archived` playbooks are never included (per the AIP-12
 *      lifecycle terminal state).
 *   4. Multiple active playbooks for the same operator stack by
 *      `priority` (higher first). `kind: block-replacement` overrides
 *      the operator's default block for the named trait;
 *      `kind: overlay` appends to the prompt.
 *
 * Pure — no I/O. Consumes a `PlaybookRegistry` (read-only) + the
 * resolution context. Lifecycle writes go through the lifecycle
 * module.
 */

import { createHash } from "node:crypto"
import type {
  Playbook,
  PlaybookStatus,
} from "./types.js"
import type { PlaybookRegistry } from "./registry.js"

export interface ResolveContext {
  /**
   * Slug of the operator the overlays apply to. Matches against
   * `binds_operator` AND `targets[].ref` (with operator/* glob).
   */
  readonly operatorSlug: string
  /**
   * Conversation id (or another stable bucketing token). Used to
   * deterministically place a conversation into shadow-traffic
   * buckets, so the same conversation consistently sees (or doesn't
   * see) a given shadow overlay.
   */
  readonly conversationId?: string
}

export interface ResolvedOverlay {
  readonly playbookSlug: string
  readonly status: PlaybookStatus
  readonly kind: Playbook["kind"]
  readonly priority: number
  /** The overlay body. */
  readonly body: string
  /** Audit attribution. */
  readonly playbookPath: string
  /** True iff this overlay came from a shadow playbook + was sampled in. */
  readonly shadowSampled: boolean
}

export interface ResolveResult {
  readonly operatorSlug: string
  readonly overlays: readonly ResolvedOverlay[]
}

export class OperatorOverlayResolver {
  constructor(private readonly registry: PlaybookRegistry) {}

  resolve(ctx: ResolveContext): ResolveResult {
    const candidates = this.registry.listBy({
      forOperatorSlug: ctx.operatorSlug,
      status: ["active", "shadow"],
    })

    const overlays: ResolvedOverlay[] = []
    for (const p of candidates) {
      if (p.status === "archived") continue
      const shadowSampled =
        p.status === "shadow"
          ? sampleShadow(ctx, p)
          : false
      if (p.status === "shadow" && !shadowSampled) continue
      overlays.push({
        playbookSlug: p.slug,
        status: p.status,
        kind: p.kind,
        priority: p.priority,
        body: p.body,
        playbookPath: p.path,
        shadowSampled,
      })
    }

    // Registry already sorts by priority desc; preserve that.
    return Object.freeze({
      operatorSlug: ctx.operatorSlug,
      overlays: Object.freeze(overlays),
    })
  }
}

// ── Shadow-traffic sampling ────────────────────────────────────────

/**
 * Deterministic 0..1 bucket from a stable token (conversation id).
 * Same conversation always lands the same bucket — so an eval batch
 * partitioned by conversation id is reproducible.
 *
 * If no conversationId is supplied (e.g. one-shot tool call), we fall
 * back to the default of NOT sampling — shadow overlays only fire on
 * traffic with stable identity.
 */
function sampleShadow(ctx: ResolveContext, p: Playbook): boolean {
  if (!ctx.conversationId) return false
  const pct = typeof p.corpus.shadowTrafficPct === "number"
    ? p.corpus.shadowTrafficPct
    : DEFAULT_SHADOW_TRAFFIC_PCT
  if (pct <= 0) return false
  if (pct >= 1) return true
  const h = createHash("sha256")
    .update(`${ctx.conversationId}|${p.slug}`)
    .digest()
  // Use the first 4 bytes as a uint32 → [0, 1).
  const u32 = h.readUInt32BE(0)
  const bucket = u32 / 0x1_0000_0000
  return bucket < pct
}

const DEFAULT_SHADOW_TRAFFIC_PCT = 0.1

/**
 * Render-ready combination of overlays for a prompt. Returns the
 * concatenated overlay bodies (priority-ordered, separated by
 * `\n\n---\n\n`). `block-replacement` overlays are listed in the
 * `replacements` field separately — the host's prompt assembler
 * decides how to merge those into the operator's named blocks.
 */
export interface RenderedOverlays {
  readonly appendBlock: string
  readonly replacements: ReadonlyArray<{
    readonly playbookSlug: string
    readonly body: string
  }>
}

export function renderOverlays(result: ResolveResult): RenderedOverlays {
  const overlays = result.overlays.filter((o) => o.kind === "overlay")
  const replacements = result.overlays
    .filter((o) => o.kind === "block-replacement")
    .map((o) => ({ playbookSlug: o.playbookSlug, body: o.body }))
  return Object.freeze({
    appendBlock: overlays.map((o) => o.body.trim()).join("\n\n---\n\n"),
    replacements: Object.freeze(replacements),
  })
}
