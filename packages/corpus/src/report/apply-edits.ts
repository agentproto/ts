/**
 * applyEdits — apply {find, replace, reason} edits (from the fix step) to
 * chapter files by EXACT match. An edit lands only if `find` occurs exactly
 * once AND `replace` adds no out-of-range [n]; everything else is reported,
 * not forced. A chapter is written only if at least one edit applied and the
 * post-check passes (still starts at "## ", no out-of-range cites).
 *
 * Reads chapter files through an injected FsPort; RETURNS the writes + a
 * human-readable apply report (the caller owns the writer).
 */

import type { FsPort } from "../ports/fs.port.js"
import type { PackFile } from "./packs.js"
import { outOfRangeCites } from "./cites.js"
import { recordedBibSha } from "./bib-sha.js"

export interface ChapterEdit {
  readonly find?: string
  readonly replace?: string
  readonly reason?: string
}

export interface ChapterEditSet {
  readonly id: string
  readonly edits?: readonly ChapterEdit[]
}

export interface ApplyEditsResult {
  /** Chapter files to (over)write — already post-checked. */
  readonly files: readonly PackFile[]
  /** The fix-apply report markdown. */
  readonly report: string
  readonly stats: {
    readonly filesChanged: number
    readonly applied: number
    readonly skipped: number
    /** Ids of chapters whose edits were computed then reverted (post-check failed). */
    readonly postCheckFailed: readonly string[]
    /** Ids of chapters skipped wholesale: written against a stale bibliography. */
    readonly staleBib: readonly string[]
  }
}

export interface ApplyEditsOptions {
  readonly results: readonly ChapterEditSet[]
  readonly bibMax: number
  /** Read-side view of the report root. */
  readonly report: FsPort
  /** Subdir holding chapter files. Default `chapters`. */
  readonly chaptersDir?: string
  /**
   * Current bibliography content-sha. When set, a chapter stamped with a
   * DIFFERENT sha is skipped wholesale — its `[n]`s (and the fixer's, which
   * read the current bibliography) point at different numberings, so exact
   * edits would silently mix the two.
   */
  readonly bibSha?: string
}

/** Chapter body start: an optional `assembleChapters({ bibSha })` marker,
 * an optional `injectAnchors: true` anchor line, then the `## ` heading. */
const HEADING_START =
  /^(?:<!-- bib-sha:[0-9a-f]+ -->\n\n)?(?:<a id="[^"]*"><\/a>\n\n)?## /

/** Count non-overlapping occurrences of `n` in `hay`. */
function occ(hay: string, n: string): number {
  let c = 0
  let i = 0
  while ((i = hay.indexOf(n, i)) !== -1) {
    c++
    i += n.length
  }
  return c
}

export async function applyEdits(
  opts: ApplyEditsOptions
): Promise<ApplyEditsResult> {
  const chaptersDir = opts.chaptersDir ?? "chapters"
  const files: PackFile[] = []
  let md =
    "# Fix-apply report (edit-based)\n\n" +
    "Each edit lands only if `find` matches exactly once and `replace` adds no out-of-range [n].\n\n"
  let applied = 0
  let skipped = 0
  let filesChanged = 0
  const postCheckFailed: string[] = []
  const staleBib: string[] = []

  for (const r of opts.results) {
    const path = `${chaptersDir}/${r.id}.md`
    let text = await opts.report.readFile(path)
    const edits = r.edits ?? []
    let n = 0
    md += `## ${r.id} — ${edits.length} proposed edit(s)\n`
    const recorded = recordedBibSha(text)
    if (opts.bibSha && recorded && recorded !== opts.bibSha) {
      staleBib.push(r.id)
      skipped += edits.length
      md +=
        `- ⚠️ SKIP ALL — chapter written against bibliography ${recorded}, ` +
        `current is ${opts.bibSha} (its [n]s cite a stale numbering; ` +
        `re-run write/assemble for this chapter)\n\n`
      continue
    }
    for (const e of edits) {
      const find = e.find ?? ""
      const replace = e.replace ?? ""
      const oor = outOfRangeCites(replace, opts.bibMax)
      const count = find ? occ(text, find) : 0
      let status: string
      if (!find) status = "SKIP (empty find)"
      else if (count === 0) status = "SKIP (find not matched verbatim)"
      else if (count > 1) status = `SKIP (find matches ${count}× — ambiguous)`
      else if (oor.length)
        status = `SKIP (replace adds out-of-range cite ${oor.join(",")})`
      else {
        text = text.replace(find, replace)
        n++
        status = "✅ applied"
      }
      md += `- ${status} — _${e.reason || ""}_\n`
      if (status.startsWith("✅")) {
        md +=
          `    find:    ${JSON.stringify(find.slice(0, 200))}\n` +
          `    replace: ${JSON.stringify(replace.slice(0, 200))}\n`
      }
    }
    const post: string[] = []
    if (!HEADING_START.test(text))
      post.push("no longer starts at '##' (optionally preceded by an anchor)")
    const oorAll = outOfRangeCites(text, opts.bibMax)
    if (oorAll.length) post.push(`out-of-range cites present: ${oorAll.join(",")}`)
    if (post.length) {
      md += `- ⚠️ POST-CHECK FAILED (${post.join("; ")}) → NOT written\n`
      if (n > 0) postCheckFailed.push(r.id)
    } else if (n > 0) {
      files.push({ path, content: text })
      filesChanged++
    }
    applied += n
    skipped += edits.length - n
    md += `- result: ${n}/${edits.length} applied${post.length ? " (reverted)" : ""}\n\n`
  }

  return {
    files,
    report: md,
    stats: { filesChanged, applied, skipped, postCheckFailed, staleBib },
  }
}
