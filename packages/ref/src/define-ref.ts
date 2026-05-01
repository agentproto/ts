import { parseCompact, serializeCompact } from "./compact.js"
import { getRefKind } from "./registry.js"
import type { AnyRef, RefHandle, ResolveContext } from "./types.js"
import { NotResolvable, UnknownRefKind } from "./types.js"

/**
 * Boundary entrypoint for AIP-27 conformance.
 *
 * Accepts either a compact string form (`<kind>:<body>`) or a value-shaped
 * object (`{ kind, ...fields }`). Returns a {@link RefHandle} that exposes
 * the canonical object form, the canonical compact form, resolution, and
 * canonical-form equality.
 */
export function defineRef(input: string | AnyRef): RefHandle {
  const value: AnyRef =
    typeof input === "string" ? parseCompact(input) : validate(input)
  const def = getRefKind(value.kind)
  if (!def) throw new UnknownRefKind(value.kind)

  const compact = `${value.kind}:${def.serialize(value)}`
  const canonical: AnyRef = parseCompact(compact)
  const resolvable = typeof def.resolve === "function"

  return {
    kind: canonical.kind,
    value: canonical,
    compact,
    resolvable,
    async resolve(ctx: ResolveContext) {
      if (!def.resolve) throw new NotResolvable(canonical.kind)
      return def.resolve(canonical, ctx)
    },
    equals(other) {
      return other.compact === compact
    },
  }
}

function validate(value: AnyRef): AnyRef {
  const def = getRefKind(value.kind)
  if (!def) throw new UnknownRefKind(value.kind)
  return def.schema.parse(value)
}

export function isResolvable(value: AnyRef): boolean {
  const def = getRefKind(value.kind)
  return !!def && typeof def.resolve === "function"
}
