/**
 * `CATALOG-CHANGELOG.md` — a human-readable "what models changed" log,
 * distinct from the changesets-driven `CHANGELOG.md` next to it (that's
 * package-version history, one entry per publish). This file answers "what
 * models did catalog-sync add or remove, and when" by reading top-to-bottom.
 *
 * Wired into `runner.ts`: every `runGenerators` call diffs each changed
 * `*.generated.ts` file's top-level id keys (before vs after) and, when a
 * run actually adds or removes model ids for at least one generator,
 * APPENDS one dated section (`## YYYY-MM-DD`) with a `### <generator name>`
 * subsection per affected generator. Sections are appended at the END of
 * the file (newest last) — a plain, non-destructive `+=`, so the writer
 * never has to parse and re-emit prior history.
 *
 * A run with no id-level drift (pricing-only changes, or a `--check` with
 * nothing to report) appends NOTHING — no empty section, no touched file,
 * no diff. addedAt ledger files (`ledger/*.json`) are intentionally NOT
 * diffed here — they never lose an id (see `added-at.ts`), so they carry no
 * "removed" signal, and every id they'd report as "added" is already
 * covered by the generator's own `*.generated.ts` diff.
 */

/** Matches a top-level (2-space-indented) quoted key of a `Record<string, X>` literal. */
const RECORD_KEY_RE = /^ {2}"([^"]+)":\s*\{/gm

/** Extracts the top-level quoted ids of a generated `Record<string, X>` map. */
export function extractRecordIds(source: string): Set<string> {
  const ids = new Set<string>()
  for (const m of source.matchAll(RECORD_KEY_RE)) {
    if (m[1] !== undefined) ids.add(m[1])
  }
  return ids
}

export interface ModelIdDiff {
  added: string[]
  removed: string[]
}

/** Diffs the id sets of a generated file's before/after content. `before` undefined = new file (no removals possible). */
export function diffModelIds(before: string | undefined, after: string): ModelIdDiff {
  const beforeIds = before !== undefined ? extractRecordIds(before) : new Set<string>()
  const afterIds = extractRecordIds(after)
  const added = [...afterIds].filter((id) => !beforeIds.has(id)).sort()
  const removed = [...beforeIds].filter((id) => !afterIds.has(id)).sort()
  return { added, removed }
}

export interface GeneratorChangelogEntry {
  /** The owning generator's `name` (e.g. `"llm:openrouter"`). */
  generator: string
  added: string[]
  removed: string[]
}

/** Renders a dated section, or `""` when every entry is empty (nothing to report). */
export function renderChangelogSection(date: string, entries: readonly GeneratorChangelogEntry[]): string {
  const nonEmpty = entries.filter((e) => e.added.length > 0 || e.removed.length > 0)
  if (nonEmpty.length === 0) return ""
  const lines: string[] = [`## ${date}`, ""]
  for (const e of nonEmpty) {
    lines.push(`### ${e.generator}`)
    if (e.added.length > 0) lines.push(`- Added: ${e.added.join(", ")}`)
    if (e.removed.length > 0) lines.push(`- Removed: ${e.removed.join(", ")}`)
    lines.push("")
  }
  return lines.join("\n").replace(/\n+$/, "\n")
}

export const CATALOG_CHANGELOG_HEADER = `# Catalog Changelog

Human-readable log of model additions/removals detected by
\`@agentproto/catalog-sync\` runs — NOT \`CHANGELOG.md\` next to it (that one is
changesets-driven package-version history). A dated section is appended
automatically here whenever a sync run adds or removes model ids; sections
are appended at the END of the file (newest last). Pricing-only drift (no id
added/removed) is not logged here — see the generated files' own git history
for that.
`

/**
 * Appends a new dated section to `existing` changelog content.
 *
 * Returns `undefined` when there is nothing to report (no generator has an
 * added/removed id this run) — the caller should leave the file untouched
 * in that case, not write an unchanged copy.
 */
export function appendChangelog(
  existing: string | undefined,
  date: string,
  entries: readonly GeneratorChangelogEntry[]
): string | undefined {
  const section = renderChangelogSection(date, entries)
  if (section === "") return undefined
  const base = existing !== undefined && existing.length > 0 ? existing.replace(/\n+$/, "\n") : CATALOG_CHANGELOG_HEADER
  return `${base}\n${section}`
}
