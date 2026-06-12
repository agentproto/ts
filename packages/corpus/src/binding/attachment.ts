/**
 * Attachment declarations — "this asset attaches to subjects matching
 * this selector", evaluated by the one matcher.
 *
 * A host keeps a flat list of declarations (a knowledge pack attaches to
 * a set of roles, a skill attaches to one position, …) and asks which
 * ones a given subject's `Dimensions` satisfy. This replaces the older
 * shape where bindings were grafted onto the subject (e.g. mutating a
 * role handle at boot): the declaration is data, matching is a pure
 * function, nothing is mutated.
 *
 * Asset-kind-agnostic and vendor-neutral — the `kind` is the host's
 * (`"pack" | "skill" | …`); the selector axes are AIP concepts. `band` /
 * `mode` are optional layering hints a host's mount step may honor; the
 * matcher itself ignores them.
 */

import type { LayerMode } from "../stack/types.js"
import { matchesSelector, type Dimensions, type Selector } from "./selector.js"
import type { AxisRegistry } from "./axes.js"

/** What a declaration attaches — an opaque, host-typed ref under a kind. */
export interface AttachmentAsset<Kind extends string = string> {
  readonly kind: Kind
  readonly ref: string
}

/** An asset + the selector deciding which subjects it attaches to. */
export interface AttachmentDeclaration<Kind extends string = string> {
  readonly asset: AttachmentAsset<Kind>
  /** Subjects whose `Dimensions` satisfy this attach the asset. */
  readonly selector: Selector
  /** Optional precedence hint for the host's mount step (see AIP-10 bands). */
  readonly band?: number
  /** Optional composition hint — `lens` vs `constraint`. */
  readonly mode?: LayerMode
}

export interface MatchAttachmentsOptions {
  /** Axis registry supplying per-axis `normalizeRef` for the matcher. */
  readonly axes?: AxisRegistry
}

/**
 * The subset of `declarations` whose selector matches `dimensions`. Order
 * is preserved; de-duplication of resulting refs is the caller's call
 * (the same asset may attach via several declarations).
 */
export function matchAttachments<Kind extends string>(
  declarations: readonly AttachmentDeclaration<Kind>[],
  dimensions: Dimensions,
  options: MatchAttachmentsOptions = {}
): AttachmentDeclaration<Kind>[] {
  return declarations.filter((d) =>
    matchesSelector(d.selector, dimensions, { axes: options.axes })
  )
}

/**
 * Matched asset refs for one kind, de-duplicated, first-seen order — the
 * flat shape most mount steps want.
 */
export function matchAttachmentRefs<Kind extends string>(
  declarations: readonly AttachmentDeclaration<Kind>[],
  kind: Kind,
  dimensions: Dimensions,
  options: MatchAttachmentsOptions = {}
): string[] {
  const seen = new Set<string>()
  for (const d of matchAttachments(declarations, dimensions, options)) {
    if (d.asset.kind === kind) seen.add(d.asset.ref)
  }
  return [...seen]
}
