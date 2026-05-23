/**
 * Language filtering — pure helpers for BCP-47 locale matching.
 *
 * Where language lives:
 *   - AIP-10 source: native top-level `language` field (already in spec).
 *   - AIP-10 entry: under `metadata.corpus.language` until the AIP-10
 *     spec hoists `language` to first-class on entries.
 *   - Workspace default: `KNOWLEDGE.md.metadata.corpus.languages.default`.
 *   - Operator locale: `OPERATOR.md.metadata.corpus.locale`.
 *
 * Default filter: an entry surfaces to an operator if its language
 * matches the operator's locale OR matches the workspace default
 * (typically en-US so generic principles aren't locale-gated). Empty
 * `language` on the entry = treat as the workspace default (it's
 * almost always the corpus's home language).
 *
 * Locale matching is loose (`en` matches `en-US` / `en-GB`) so we
 * don't drown the user in misses on regional variants.
 */

export interface ResolveLanguageFilterInput {
  /** BCP-47 locale the caller is operating in. */
  readonly callerLocale?: string
  /**
   * Default language declared in `KNOWLEDGE.md.metadata.corpus.languages.default`.
   * Used as the implicit language for entries that don't declare one.
   */
  readonly workspaceDefaultLanguage?: string
}

export interface LanguageFilter {
  /**
   * The set of language codes that surface. Used by middleware to
   * filter hits silently. Empty set = no language filter (everyone
   * sees everything; happens when neither caller nor workspace
   * declares a language).
   */
  readonly allowedLanguages: ReadonlySet<string>
  /**
   * Whether entries with no declared language should pass through.
   * True when the workspace declares a default — those entries
   * inherit it.
   */
  readonly allowUnspecified: boolean
}

export function resolveLanguageFilter(
  input: ResolveLanguageFilterInput
): LanguageFilter {
  const set = new Set<string>()
  if (input.callerLocale) addExpansions(set, input.callerLocale)
  if (input.workspaceDefaultLanguage)
    addExpansions(set, input.workspaceDefaultLanguage)
  return Object.freeze({
    allowedLanguages: set,
    // If a workspace default exists, entries without an explicit
    // language inherit it → pass-through. If neither caller nor
    // workspace declares one, the filter is effectively off (everyone
    // surfaces; the helper isn't called for cross-language scoping).
    allowUnspecified:
      set.size === 0 ? true : input.workspaceDefaultLanguage != null,
  })
}

export function matchesLanguageFilter(
  entryLanguage: string | undefined,
  filter: LanguageFilter
): boolean {
  if (filter.allowedLanguages.size === 0) return true // no filter
  if (!entryLanguage) return filter.allowUnspecified
  // Exact + loose (en-US matches en) — try both directions for
  // tolerance.
  const lower = entryLanguage.toLowerCase()
  if (filter.allowedLanguages.has(lower)) return true
  const baseLang = lower.split("-")[0]
  if (baseLang && filter.allowedLanguages.has(baseLang)) return true
  // Caller had "en", entry has "en-US" → also accept.
  for (const allowed of filter.allowedLanguages) {
    if (lower.startsWith(allowed + "-")) return true
  }
  return false
}

// ── Helpers ─────────────────────────────────────────────────────────

function addExpansions(set: Set<string>, locale: string): void {
  const lower = locale.toLowerCase()
  set.add(lower)
  const base = lower.split("-")[0]
  if (base) set.add(base)
}

/**
 * Convenience: read the operator's locale from frontmatter.
 * Falls back to undefined when not declared.
 */
export function readOperatorLocale(
  operatorFrontmatter: Readonly<Record<string, unknown>>
): string | undefined {
  const meta = operatorFrontmatter.metadata as
    | { corpus?: { locale?: unknown } }
    | undefined
  const l = meta?.corpus?.locale
  return typeof l === "string" ? l : undefined
}

/**
 * Read the workspace's default language from KNOWLEDGE.md.
 */
export function readWorkspaceDefaultLanguage(
  workspaceFrontmatter: Readonly<Record<string, unknown>>
): string | undefined {
  const meta = workspaceFrontmatter.metadata as
    | { corpus?: { languages?: { default?: unknown } } }
    | undefined
  const def = meta?.corpus?.languages?.default
  return typeof def === "string" ? def : undefined
}

/**
 * Read an entry / source's language. Sources expose it at top level
 * (AIP-10 spec); entries put it under `metadata.corpus.language`
 * until the corresponding AIP-10 amendment lands.
 */
export function readEntryLanguage(
  frontmatter: Readonly<Record<string, unknown>>
): string | undefined {
  const top = frontmatter.language
  if (typeof top === "string") return top
  const meta = frontmatter.metadata as
    | { corpus?: { language?: unknown } }
    | undefined
  const corp = meta?.corpus?.language
  return typeof corp === "string" ? corp : undefined
}
