/**
 * `boundaries` (AIP-53 APP frontmatter / `defineApp`): validation shared by
 * the `.md` loader and `defineApp`.
 */

import type { AppBoundariesDefinition } from "./types.js"

/** A `boundaries.hostReads` entry: relative to the host repo root, no `..`
 *  segment, not absolute, not `.` (the whole repo), no surrounding
 *  whitespace, no line terminator anywhere. Same source as the AIP-53
 *  APP.schema.json `hostReads` item pattern: anchored at both ends, and
 *  without the `s` flag `.` matches no line terminator (`\n`, `\r`, U+2028,
 *  U+2029), so an entry holding one is refused like the schema refuses it. */
export const HOST_READ_PATH_RE = /^(?!\/)(?!\.?\/*$)(?!\s)(?!(?:.*\/)?\.\.(?:\/|$)).*\S$/

export const HOST_READS_MAX = 64

/**
 * Validate a raw `boundaries` value. Returns the error text (naming the
 * offending field) or `undefined` when it is valid.
 */
export function boundariesError(raw: unknown): string | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return "'boundaries' must be an object { enforce?, hostReads? }."
  }
  const b = raw as Record<string, unknown>
  const extra = Object.keys(b).filter(k => k !== "enforce" && k !== "hostReads")
  if (extra.length > 0) return `'boundaries.${extra[0]}' is not a supported field (expected enforce, hostReads).`
  if (b.enforce !== undefined && b.enforce !== "required" && b.enforce !== "best-effort") {
    return `'boundaries.enforce' must be "required" or "best-effort".`
  }
  if (b.hostReads !== undefined) {
    if (!Array.isArray(b.hostReads)) return "'boundaries.hostReads' must be an array of relative paths."
    if (b.hostReads.length > HOST_READS_MAX) return `'boundaries.hostReads' holds at most ${HOST_READS_MAX} paths.`
    for (const [i, p] of b.hostReads.entries()) {
      if (typeof p !== "string" || !HOST_READ_PATH_RE.test(p)) {
        return `'boundaries.hostReads[${i}]' must be a path relative to the host repo root, with no '..' segment, not the repo root itself, no surrounding whitespace, no line break (got ${JSON.stringify(p)}).`
      }
    }
  }
  return undefined
}

/** Narrowing form of {@link boundariesError}. */
export function isAppBoundaries(raw: unknown): raw is AppBoundariesDefinition {
  return boundariesError(raw) === undefined
}
