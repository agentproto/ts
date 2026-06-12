/**
 * Attachment-binding axes — the dimensions a selector can target.
 *
 * An axis is a named dimension of the consuming subject (an operator,
 * usually): its identity slug, the AIP-47 role it fulfils, the
 * host-assigned position label, the capabilities it carries. Assets
 * (playbook overlays, knowledge packs, skills) declare a `Selector`
 * over these axes; the host supplies `Dimensions` for the subject and
 * one matcher evaluates `selector ⊨ dimensions`.
 *
 * This package ships only the AIP-concept axes. Hosts register extra
 * axes (org units, regions, compliance regimes, …) on their own
 * registry — nothing here knows about any host's org model.
 */

import { createRegistry, type Registry } from "@agentproto/registry"

export interface AxisDefinition {
  /** Axis id — the key used in `selector:` frontmatter and in Dimensions. */
  readonly id: string
  /** AIP that owns the axis's value vocabulary, when one does. */
  readonly aip?: number
  /** Doc line for catalog/UI surfaces. */
  readonly description?: string
  /**
   * Authoring-time ref check. Returns an error message, or null when
   * the ref is acceptable. Hosts inject catalog-aware validators here
   * (e.g. "role ref must be a known catalog slug").
   */
  readonly validateRef?: (ref: string) => string | null
  /**
   * Canonicalize a ref before matching — absorbs the AIP-12 ref shapes
   * (`operator/<slug>`, `ws://operators/<slug>`, globs → `"*"`).
   */
  readonly normalizeRef?: (ref: string) => string
}

/** Matches any present value on the axis. */
export const ANY_REF = "*"

/**
 * Ref-shape normalizer for an axis addressed as `<singular>/<slug>` or
 * `ws://<plural>/<slug>` — the shapes AIP-12 targets historically used.
 * Globs (`<singular>/*`, `ws://<plural>/*`) collapse to `ANY_REF`.
 */
export function prefixedRefNormalizer(
  singular: string,
  plural: string
): (ref: string) => string {
  const bare = `${singular}/`
  const ws = `ws://${plural}/`
  return (ref) => {
    const stripped = ref.startsWith(bare)
      ? ref.slice(bare.length)
      : ref.startsWith(ws)
        ? ref.slice(ws.length)
        : ref
    return stripped === "*" ? ANY_REF : stripped
  }
}

const SLUG_RE = /^[a-z][a-z0-9-]*[a-z0-9]$/

function slugValidator(ref: string): string | null {
  if (ref === ANY_REF) return null
  return SLUG_RE.test(ref)
    ? null
    : `not a slug (lowercase, digits, dashes): "${ref}"`
}

/** The operator's own slug — AIP-9 identity. */
export const identityAxis: AxisDefinition = {
  id: "identity",
  aip: 9,
  description: "The subject's own slug — targets one specific operator.",
  normalizeRef: prefixedRefNormalizer("operator", "operators"),
  validateRef: slugValidator,
}

/** The AIP-47 catalog role (job) the operator fulfils. */
export const roleAxis: AxisDefinition = {
  id: "role",
  aip: 47,
  description:
    "The AIP-47 catalog role (job) the subject fulfils — targets every operator in the role.",
  normalizeRef: prefixedRefNormalizer("role", "roles"),
  validateRef: slugValidator,
}

/** The host-assigned, user-settable seat label (slugified). */
export const positionAxis: AxisDefinition = {
  id: "position",
  aip: 6,
  description:
    "The host-assigned seat label (slugified) — targets the one operator holding the seat. See AIP-47 §Role vs Position vs Access role.",
  normalizeRef: prefixedRefNormalizer("position", "positions"),
  validateRef: slugValidator,
}

/** A capability slug the subject carries. */
export const capabilityAxis: AxisDefinition = {
  id: "capability",
  aip: 9,
  description: "A capability slug the subject carries.",
  normalizeRef: prefixedRefNormalizer("capability", "capabilities"),
  validateRef: slugValidator,
}

export const WELL_KNOWN_AXES: readonly AxisDefinition[] = Object.freeze([
  identityAxis,
  roleAxis,
  positionAxis,
  capabilityAxis,
])

export type AxisRegistry = Registry<AxisDefinition>

/**
 * Axis registry seeded with the well-known AIP axes. Hosts pass their
 * extra axes; ids must not collide with the well-known set.
 */
export function createAxisRegistry(
  extra: readonly AxisDefinition[] = []
): AxisRegistry {
  const registry = createRegistry<AxisDefinition>({
    family: "binding-axis",
    keyBy: (axis) => axis.id,
  })
  for (const axis of WELL_KNOWN_AXES) registry.register(axis)
  for (const axis of extra) registry.register(axis)
  return registry
}
