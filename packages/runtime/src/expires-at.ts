/**
 * Shared handling for the `expiresAt` lifecycle backstop on follows and
 * sentinels.
 *
 * `Date.parse("garbage")` is `NaN` and `NaN <= now` is always false, so an
 * unvalidated value would make a record immortal and silently defeat the
 * bounded-lifetime guarantee. Two guards keep that from happening:
 *   - {@link normalizeExpiresAt} drops an unparseable value at write time so
 *     the store falls back to its default TTL;
 *   - {@link isExpiresAtReached} treats an unparseable value that is already
 *     persisted as expired (fail closed) rather than as "never".
 */

/** The input unchanged when it is a parseable timestamp, else `undefined`. */
export function normalizeExpiresAt(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined
  return Number.isNaN(Date.parse(value)) ? undefined : value
}

/** True when `expiresAt` is set and has passed — or is set but unparseable. */
export function isExpiresAtReached(expiresAt: string | undefined, nowMs: number): boolean {
  if (expiresAt === undefined) return false
  const ms = Date.parse(expiresAt)
  return Number.isNaN(ms) || ms <= nowMs
}
