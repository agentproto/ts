/**
 * ReportContent — the ONE medium-agnostic shape of a finished report.
 *
 * `buildReportContent` reads the report root (config + chapters/ + the
 * bibliography view) and RETURNS the structured content: an ordered list of
 * sections (each raw markdown) plus the structured bibliography and document
 * metadata. It is PURE and port-injected like the rest of the engine — it
 * never touches the dataset and never renders HTML/PDF (no Chrome here).
 *
 * Every render medium is an AIP `render.*` tool whose input is a
 * `ReportContent`; the canvakit driver (in `@canvakit/report`) is the only
 * place HTML/PDF lives. The markdown medium is reconstructed losslessly by
 * `reportContentToMarkdown` — which is exactly what `stitchReport` emits, so
 * REPORT.md byte-parity is preserved (the two share `collectReportSections`).
 */

import { z } from "zod"
import type { FsPort } from "../ports/fs.port.js"
import type { ReportConfig } from "./types.js"
import { bibliographySha, recordedBibSha, stripBibShaMarker } from "./bib-sha.js"

/** What role a section plays in the document. */
export const reportSectionKindSchema = z.enum([
  "front",
  "part",
  "chapter",
  "annexes",
  "sources",
])

/** One contiguous unit of a report (front, a part divider, a chapter, …). */
export const reportSectionSchema = z.object({
  /** Stable id — chapter id, or `_front`/`_annexes`/`_sources` for the glue. */
  id: z.string(),
  /** Human label (heading text, leading `#`s stripped). May be "". */
  title: z.string(),
  /** The section's raw markdown, exactly as it appears in REPORT.md. */
  markdown: z.string(),
  kind: reportSectionKindSchema,
})

/** One global citation source (mirrors `views/_bibliography.json`). */
export const bibEntrySchema = z.object({
  n: z.number(),
  id: z.string(),
  title: z.string(),
  url: z.string(),
})

/**
 * The medium-agnostic content a `render.*` tool consumes — the single source
 * of truth for "what a report's content is". Zod so the render tool schemas
 * can embed it directly (one definition across the engine and every renderer).
 */
export const reportContentSchema = z.object({
  title: z.string(),
  sections: z.array(reportSectionSchema),
  bibliography: z
    .object({
      mode: z.literal("numbered"),
      entries: z.array(bibEntrySchema),
    })
    .optional(),
  /** Document metadata (brand · subtitle · tag · custodian) — presentation-free. */
  meta: z.record(z.string(), z.string()).optional(),
})

export type ReportSection = z.infer<typeof reportSectionSchema>
export type BibEntry = z.infer<typeof bibEntrySchema>
export type ReportContent = z.infer<typeof reportContentSchema>

export interface CollectSectionsOptions {
  readonly config: ReportConfig
  /** Read-side view of the report root (chapters/ + views/ + front/annexes). */
  readonly report: FsPort
  /** Subdir holding the written chapter files. Default `chapters`. */
  readonly chaptersDir?: string
  /** Subdir holding the bibliography. Default `views`. */
  readonly viewsDir?: string
  /**
   * Verify each chapter's recorded bib-sha marker (stamped by
   * `assembleChapters({ bibSha })`) against the current
   * `_bibliography.json` before stitching, and throw when the bibliography
   * has been renumbered since the chapter was written — its `[n]`s would
   * silently cite the wrong sources. Default true; unstamped (legacy)
   * chapters are never checked. Markers are stripped from the output
   * sections either way.
   */
  readonly checkBibSha?: boolean
}

const stripHeading = (s: string): string => s.replace(/^#+\s*/, "").trim()

/** Parse `<viewsDir>/_bibliography.json` → entries, or null when absent/invalid. */
async function readBibEntries(
  report: FsPort,
  viewsDir: string
): Promise<BibEntry[] | null> {
  try {
    const raw = await report.readFile(`${viewsDir}/_bibliography.json`)
    const parsed = JSON.parse(raw) as { sources?: unknown }
    const src = Array.isArray(parsed.sources) ? parsed.sources : []
    return src.map((s) => {
      const o = (s ?? {}) as Record<string, unknown>
      return {
        n: typeof o.n === "number" ? o.n : 0,
        id: typeof o.id === "string" ? o.id : "",
        title: typeof o.title === "string" ? o.title : "",
        url: typeof o.url === "string" ? o.url : "",
      }
    })
  } catch {
    return null
  }
}

/**
 * Collect a report's ordered sections from the report root. This is the
 * single read path shared by `stitchReport` (markdown medium) and
 * `buildReportContent` (every other medium), so the section boundaries — and
 * therefore REPORT.md — are identical regardless of the consumer.
 *
 * Order: front? · (parts ? part-heading + its chapters : chapters in config
 * order) · annexes? · Sources (from the bibliography). Mirrors the legacy
 * stitch exactly; all reads are report-side (the dataset is never touched).
 */
export async function collectReportSections(
  opts: CollectSectionsOptions
): Promise<ReportSection[]> {
  const { config, report } = opts
  const chaptersDir = opts.chaptersDir ?? "chapters"
  const viewsDir = opts.viewsDir ?? "views"

  const rd = async (p: string): Promise<string> =>
    (await report.readFile(p)).trim()
  const rdOpt = async (p: string): Promise<string | null> => {
    try {
      return await rd(p)
    } catch {
      return null
    }
  }
  const titleOf = (id: string): string =>
    config.chapters.find((c) => c.id === id)?.title ?? id

  const sections: ReportSection[] = []

  const front = await rdOpt(config.frontFile ?? `${chaptersDir}/_front.md`)
  if (front) sections.push({ id: "_front", title: "", markdown: front, kind: "front" })

  if (config.parts && config.parts.length) {
    for (const part of config.parts) {
      sections.push({
        id: stripHeading(part.heading).toLowerCase().replace(/[^a-z0-9]+/g, "-"),
        title: stripHeading(part.heading),
        markdown: part.heading,
        kind: "part",
      })
      for (const id of part.chapters ?? []) {
        sections.push({
          id,
          title: titleOf(id),
          markdown: await rd(`${chaptersDir}/${id}.md`),
          kind: "chapter",
        })
      }
    }
  } else {
    for (const c of config.chapters) {
      sections.push({
        id: c.id,
        title: c.title,
        markdown: await rd(`${chaptersDir}/${c.id}.md`),
        kind: "chapter",
      })
    }
  }

  if (config.annexesFile) {
    const annexes = await rdOpt(config.annexesFile)
    if (annexes)
      sections.push({ id: "_annexes", title: "Annexes", markdown: annexes, kind: "annexes" })
  }

  const bib = (await rd(`${viewsDir}/_bibliography.md`))
    .replace(/^# Bibliography.*$/m, "")
    .trim()
  sections.push({
    id: "_sources",
    title: "Sources",
    markdown: "## Sources\n\n" + bib,
    kind: "sources",
  })

  // Bib-sha honesty check: a chapter stamped by `assembleChapters({ bibSha })`
  // must match the CURRENT bibliography numbering — regenerating packs mid-run
  // renumbers [n] globally while the chapter's literal [n]s stay put, which
  // the range check can never see. Unstamped chapters (legacy) pass untouched.
  const bibEntries = await readBibEntries(report, viewsDir)
  const currentSha =
    bibEntries && bibEntries.length ? bibliographySha(bibEntries) : null
  const stale: string[] = []
  const out = sections.map((s) => {
    if (s.kind !== "chapter") return s
    const recorded = recordedBibSha(s.markdown)
    if (!recorded) return s
    if ((opts.checkBibSha ?? true) && currentSha && recorded !== currentSha)
      stale.push(`${s.id} (written against ${recorded})`)
    return { ...s, markdown: stripBibShaMarker(s.markdown) }
  })
  if (stale.length) {
    throw new Error(
      `bibliography has been renumbered (current sha ${currentSha}) since ` +
        `these chapters were written — their [n] citations point at the ` +
        `wrong sources: ${stale.join(", ")}. Re-run write/assemble for them ` +
        `(or pass checkBibSha: false to override).`
    )
  }
  return out
}

/**
 * Reconstruct the canonical REPORT.md from collected sections. Byte-identical
 * to the legacy stitch output (`out.join("\n\n") + "\n"`).
 */
export function reportContentToMarkdown(
  sections: readonly ReportSection[]
): string {
  return sections.map((s) => s.markdown).join("\n\n") + "\n"
}

export type BuildReportContentOptions = CollectSectionsOptions

/**
 * Build the medium-agnostic {@link ReportContent} for a report. Pure: reads
 * the report root through the injected FsPort and returns structured content —
 * the single input every `render.*` tool consumes.
 */
export async function buildReportContent(
  opts: BuildReportContentOptions
): Promise<ReportContent> {
  const { config, report } = opts
  const viewsDir = opts.viewsDir ?? "views"

  const sections = await collectReportSections(opts)

  // Title: explicit config, else the first H1 in the front matter, else fallback.
  let title = config.title?.trim() ?? ""
  if (!title) {
    const front = sections.find((s) => s.kind === "front")
    title = front?.markdown.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? "Report"
  }

  // Structured bibliography from the JSON view (the .md is for the Sources
  // block). Absent/invalid view → content is still valid without one.
  let bibliography: ReportContent["bibliography"]
  const entries = await readBibEntries(report, viewsDir)
  if (entries && entries.length) bibliography = { mode: "numbered", entries }

  // Document metadata — presentation-free scalars from the cover, if present.
  const meta: Record<string, string> = {}
  const cover = config.cover
  if (cover) {
    for (const k of ["brand", "subtitle", "tag", "meta"] as const) {
      const v = cover[k]
      if (typeof v === "string" && v.trim()) meta[k] = v.trim()
    }
  }
  if (config.profile) meta.profile = config.profile

  return {
    title,
    sections,
    ...(bibliography ? { bibliography } : {}),
    ...(Object.keys(meta).length ? { meta } : {}),
  }
}
