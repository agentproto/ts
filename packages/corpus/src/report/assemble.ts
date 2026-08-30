/**
 * assembleChapters — turn the write step's raw per-chapter drafts into clean
 * chapter files. Pure: in-memory drafts → files to write (the caller owns the
 * report-rooted writer). Mechanical only — strips agent preambles, normalizes
 * `[a→b]` cross-refs to `[b]`, collapses blank runs; no model calls.
 */

import type { PackFile } from "./packs.js"
import { outOfRangeCites } from "./cites.js"

export interface ChapterDraft {
  /** Chapter id (= `<chaptersDir>/<ch>.md`). */
  readonly ch: string
  readonly draft: string
}

export interface AssembleResult {
  readonly files: readonly PackFile[]
  readonly stats: {
    readonly chapters: number
    readonly preamblesStripped: number
    readonly withOutOfRangeCites: number
    readonly outOfRange: ReadonlyArray<{ ch: string; cites: number[] }>
  }
}

export interface AssembleOptions {
  readonly chapters: readonly ChapterDraft[]
  /** Highest valid citation [n]; cites above it are flagged (not dropped). */
  readonly bibMax: number
  /** Subdir under the report root for chapter files. Default `chapters`. */
  readonly chaptersDir?: string
  /**
   * Prepend `<a id="<ch>"></a>` to each chapter body so canvakit's
   * `resolveWikilinks` can resolve `[[chapter-id]]` cross-refs at render time.
   * Default false — existing callers see zero output change.
   */
  readonly injectAnchors?: boolean
}

const PREAMBLE = /^\s*(?:I have|I'll|Here is|Here's|Writing|Let me|Okay|Done)/i
const CROSSREF = /\[(\d{1,3})\s*(?:→|->|—>|to see|see)\s*(?:see\s*)?(\d{1,3})\]/g

/** Drop any leading agent chatter before the first "## " and tidy whitespace. */
export function cleanDraft(draft: string | undefined): string {
  if (!draft) return ""
  let s = draft.replace(/\r/g, "")
  const i = s.indexOf("## ")
  if (i > 0) s = s.slice(i)
  s = s.replace(CROSSREF, "[$2]")
  return s.replace(/\n{3,}/g, "\n\n").trim()
}

export function assembleChapters(opts: AssembleOptions): AssembleResult {
  const chaptersDir = opts.chaptersDir ?? "chapters"
  const files: PackFile[] = []
  let preamblesStripped = 0
  const outOfRange: Array<{ ch: string; cites: number[] }> = []

  for (const c of opts.chapters) {
    let body = cleanDraft(c.draft)
    if (PREAMBLE.test(c.draft || "")) preamblesStripped++
    if (body && opts.injectAnchors) body = `<a id="${c.ch}"></a>\n\n${body}`
    if (body) files.push({ path: `${chaptersDir}/${c.ch}.md`, content: body + "\n" })
    const oor = outOfRangeCites(body, opts.bibMax)
    if (oor.length) outOfRange.push({ ch: c.ch, cites: oor })
  }

  return {
    files,
    stats: {
      chapters: opts.chapters.length,
      preamblesStripped,
      withOutOfRangeCites: outOfRange.length,
      outOfRange,
    },
  }
}
