import type { Envelope } from "./types.js"

/** Which envelope types are delivered through the kernel's level mapping.
 *  Absent or empty applies nothing: a producer that never opts in keeps its
 *  original delivery behaviour. */
export interface DeliveryApplyConfig {
  /** Glob -> on/off. `session.*` matches every session type, `*` matches
   *  everything. The most specific match wins (exact, then longest prefix). */
  types?: Record<string, boolean>
}

/** Same glob vocabulary the classifier registry speaks: a bare `*`, a
 *  `<prefix>*`, or an exact type. */
export function typeMatches(pattern: string, type: string): boolean {
  if (pattern === "*") return true
  if (pattern.endsWith("*")) return type.startsWith(pattern.slice(0, -1))
  return pattern === type
}

/** Does this envelope type opt into kernel application? Exact keys beat
 *  globs; among globs the longest matching prefix wins. */
export function shouldApplyDelivery(apply: DeliveryApplyConfig | undefined, type: string): boolean {
  const types = apply?.types
  if (!types) return false
  if (Object.prototype.hasOwnProperty.call(types, type)) return types[type] === true
  let best: { length: number; on: boolean } | undefined
  for (const [pattern, on] of Object.entries(types)) {
    if (!pattern.endsWith("*") || !typeMatches(pattern, type)) continue
    const length = pattern.length
    if (best === undefined || length > best.length) best = { length, on }
  }
  return best?.on === true
}

/** Convenience overload used by producers that only have an envelope. */
export function shouldApplyEnvelope(apply: DeliveryApplyConfig | undefined, envelope: Pick<Envelope, "type">): boolean {
  return shouldApplyDelivery(apply, envelope.type)
}
