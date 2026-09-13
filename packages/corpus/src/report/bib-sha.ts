/**
 * Bibliography content-sha — the stability contract behind `[n]` citations.
 *
 * A chapter's `[n]` markers are only honest against the exact bibliography
 * numbering they were written from. `views/_bibliography.json` is regenerated
 * on every packs run and numbering is global (facet-ordered, then title), so
 * a mid-run source addition renumbers EVERYTHING and silently repoints every
 * already-written citation. The range check (`outOfRangeCites`) cannot see
 * that: `[7]` stays in range while meaning a different source.
 *
 * The contract: the sha is computed over the ordered `n:id` mapping only —
 * cosmetic edits (title/url fixes that don't reorder) keep chapters valid;
 * any renumbering changes the sha. `buildPacks` embeds it in the JSON view,
 * `assembleChapters` stamps it into each chapter as an HTML-comment marker,
 * and `collectReportSections` refuses to stitch a chapter whose recorded sha
 * no longer matches the current bibliography.
 */

import { createHash } from "node:crypto"

/** The subset of a bibliography source the sha is computed over. */
export interface BibShaSource {
  readonly n?: number | undefined
  readonly id: string
}

/**
 * Content-sha of a bibliography's `[n]` → source-id mapping (first 12 hex
 * chars of sha256 over the `n`-ordered `n:id` lines). Title/url edits that
 * don't renumber leave it unchanged; any renumbering changes it.
 */
export function bibliographySha(
  sources: ReadonlyArray<BibShaSource>
): string {
  const lines = [...sources]
    .sort((a, b) => (a.n ?? 0) - (b.n ?? 0))
    .map((s) => `${s.n ?? 0}:${s.id}`)
  return createHash("sha256").update(lines.join("\n")).digest("hex").slice(0, 12)
}

/** The marker line `assembleChapters` stamps as a chapter's first line. */
export function bibShaMarker(sha: string): string {
  return `<!-- bib-sha:${sha} -->`
}

const MARKER_RE = /^<!-- bib-sha:([0-9a-f]+) -->\n\n?/

/** The bib sha a chapter file was written against, or null if unstamped. */
export function recordedBibSha(chapterMd: string): string | null {
  return MARKER_RE.exec(chapterMd)?.[1] ?? null
}

/** Chapter body without its leading bib-sha marker (identity if unstamped). */
export function stripBibShaMarker(chapterMd: string): string {
  return chapterMd.replace(MARKER_RE, "")
}
