/**
 * AIP-10 slug helpers — the single source of truth for turning arbitrary
 * text or paths into schema-valid slugs. Replaces the three drifted
 * `makeSlug` copies (web / local-files / distill importers) and the two
 * `uniqueSlug` copies, so a rule change lands once instead of in four
 * places.
 *
 * Two AIP-10 slug shapes:
 *   - **source** id `^[a-z0-9][a-z0-9-]*$` — a leading digit is allowed.
 *   - **entry / role / tag** id `^[a-z][a-z0-9-]*[a-z0-9]$` — must start
 *     with a letter and end alphanumeric. Pass `leadingLetter: true`.
 */

const SOURCE_SLUG = /^[a-z0-9][a-z0-9-]*$/
const ENTRY_SLUG = /^[a-z][a-z0-9-]*[a-z0-9]$/

export interface SlugifyOptions {
  /** Max length before the trailing-dash trim. Default 96. */
  readonly maxLen?: number
  /** Returned when the slugified result is empty / degenerate. Default "item". */
  readonly fallback?: string
  /**
   * Guarantee the AIP-10 *entry* shape: a leading letter (prefix `e-` when
   * the slug would otherwise start with a digit) and length ≥ 2.
   */
  readonly leadingLetter?: boolean
  /** Strip a leading `http(s)://` first — for slugging a URL fallback. */
  readonly stripScheme?: boolean
}

/** Slugify arbitrary text into an AIP-10-valid id. */
export function slugify(input: string, opts: SlugifyOptions = {}): string {
  const maxLen = opts.maxLen ?? 96
  const fallback = opts.fallback ?? "item"
  let s = input
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // strip combining diacritics
  if (opts.stripScheme) s = s.replace(/^https?:\/\//, "")
  s = s
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-{2,}/g, "-")
    .slice(0, maxLen)
    .replace(/^-+|-+$/g, "") // trim AFTER slicing, so a cut mid-dash can't leave one
  if (opts.leadingLetter && s && !/^[a-z]/.test(s)) {
    s = `e-${s}`.slice(0, maxLen).replace(/-+$/g, "")
  }
  return s.length >= 2 ? s : fallback
}

/**
 * Disambiguate a slug against a set of already-used ones by appending
 * `-2`, `-3`, … The suffix is numeric, so an entry-shaped base stays
 * entry-valid (ends alphanumeric).
 */
export function uniqueSlug(base: string, seen: Set<string>, maxLen = 96): string {
  let slug = base
  let n = 2
  while (seen.has(slug)) {
    slug = `${base}-${n++}`.slice(0, maxLen).replace(/-+$/g, "")
  }
  seen.add(slug)
  return slug
}

/** True when `s` is a valid AIP-10 source id (leading digit allowed). */
export function isSourceSlug(s: string): boolean {
  return SOURCE_SLUG.test(s) && s.length >= 2 && s.length <= 96
}

/** True when `s` is a valid AIP-10 entry/role/tag id (leading letter). */
export function isEntrySlug(s: string): boolean {
  return ENTRY_SLUG.test(s) && s.length >= 2 && s.length <= 96
}
