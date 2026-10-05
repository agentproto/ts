/**
 * Tiny pure semver-range checker for `requires.apps[].version` — the only
 * version constraint the app→app call mechanism supports. Deliberately small:
 * an exact version, a caret on the major (`^1`, `^1.2`, `^1.2.3`), or a
 * tilde on the major[.minor] (`~1`, `~1.2`, `~1.2.3`). No dependency on a
 * semver package — the surface is three comparison shapes, not a grammar.
 *
 * Versions are `major.minor.patch` with an optional prerelease/build suffix
 * (the APP.md `version` pattern); the suffix is ignored for comparison, so
 * `1.2.3-rc1` satisfies `^1` exactly as `1.2.3` would.
 */

const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)(?:[-+][\w.\-]+)?$/

type VersionTuple = readonly [number, number, number]

export type VersionRange =
  | { readonly kind: "exact"; readonly version: VersionTuple }
  | { readonly kind: "caret"; readonly version: VersionTuple }
  /** `minorGiven` distinguishes `~1` (any minor of that major) from
   *  `~1.2` / `~1.2.3` (that minor line only). */
  | { readonly kind: "tilde"; readonly version: VersionTuple; readonly minorGiven: boolean }

function parseVersion(v: string): VersionTuple {
  const m = VERSION_RE.exec(v)
  if (!m) {
    throw new Error(`invalid version "${v}" — expected major.minor.patch (e.g. "1.2.3").`)
  }
  return [Number(m[1]), Number(m[2]), Number(m[3])]
}

function compare(a: VersionTuple, b: VersionTuple): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2]
}

/** Parse a supported range shape. Throws on anything else — callers with
 *  user-authored input wrap this for a field-prefixed diagnostic. */
export function parseVersionRange(range: string): VersionRange {
  let m = /^\^(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(range)
  if (m !== null) {
    return {
      kind: "caret",
      version: [Number(m[1]), m[2] !== undefined ? Number(m[2]) : 0, m[3] !== undefined ? Number(m[3]) : 0],
    }
  }
  m = /^~(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(range)
  if (m !== null) {
    return {
      kind: "tilde",
      version: [Number(m[1]), m[2] !== undefined ? Number(m[2]) : 0, m[3] !== undefined ? Number(m[3]) : 0],
      minorGiven: m[2] !== undefined,
    }
  }
  if (VERSION_RE.test(range)) return { kind: "exact", version: parseVersion(range) }
  throw new Error(
    `invalid version range "${range}" — expected an exact version ("1.2.3"), ` +
      `a caret ("^1", "^1.2", "^1.2.3"), or a tilde ("~1", "~1.2", "~1.2.3").`,
  )
}

/** True when `version` satisfies `range`. Throws on a malformed version or
 *  range — both are validated at manifest-parse time, so reaching this with
 *  bad input is a programming error, not a user one. */
export function versionSatisfies(version: string, range: string): boolean {
  const v = parseVersion(version)
  const r = parseVersionRange(range)
  if (r.kind === "exact") return compare(v, r.version) === 0
  if (compare(v, r.version) < 0) return false
  if (r.kind === "caret") return v[0] === r.version[0]
  return v[0] === r.version[0] && (!r.minorGiven || v[1] === r.version[1])
}
