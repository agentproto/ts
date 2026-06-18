/**
 * stitchReport — assemble the final REPORT.md = front + part dividers +
 * chapters + annexes + a Sources section (from the global bibliography), per
 * the config's `parts[]`. Pure: reads report-side files through an injected
 * FsPort and RETURNS the document string (the caller writes REPORT.md).
 *
 * All reads are report-side (chapters + views) — the dataset is not touched.
 */

import type { FsPort } from "../ports/fs.port.js"
import type { ReportConfig } from "./types.js"

export interface StitchOptions {
  readonly config: ReportConfig
  /** Read-side view of the report root (chapters/ + views/ + front/annexes). */
  readonly report: FsPort
  /** Subdir holding the written chapter files. Default `chapters`. */
  readonly chaptersDir?: string
  /** Subdir holding the bibliography. Default `views`. */
  readonly viewsDir?: string
}

export interface StitchResult {
  readonly content: string
  readonly wordCount: number
}

export async function stitchReport(opts: StitchOptions): Promise<StitchResult> {
  const { config, report } = opts
  const chaptersDir = opts.chaptersDir ?? "chapters"
  const viewsDir = opts.viewsDir ?? "views"

  const rd = async (p: string): Promise<string> => (await report.readFile(p)).trim()
  const rdOpt = async (p: string): Promise<string | null> => {
    try {
      return await rd(p)
    } catch {
      return null
    }
  }
  const ch = (id: string): Promise<string> => rd(`${chaptersDir}/${id}.md`)

  const out: string[] = []
  // Front matter is optional — auto-generated reports may not author one.
  const front = await rdOpt(config.frontFile ?? `${chaptersDir}/_front.md`)
  if (front) out.push(front)
  if (config.parts && config.parts.length) {
    // Explicit structure: part dividers + their chapters in declared order.
    for (const part of config.parts) {
      out.push(part.heading)
      for (const id of part.chapters ?? []) out.push(await ch(id))
    }
  } else {
    // No parts (auto-generated report): all chapters in config order, no dividers.
    for (const c of config.chapters) out.push(await ch(c.id))
  }
  if (config.annexesFile) {
    const annexes = await rdOpt(config.annexesFile)
    if (annexes) out.push(annexes)
  }

  const bib = (await rd(`${viewsDir}/_bibliography.md`))
    .replace(/^# Bibliography.*$/m, "")
    .trim()
  out.push("## Sources\n\n" + bib)

  const content = out.join("\n\n") + "\n"
  return { content, wordCount: out.join(" ").split(/\s+/).length }
}
